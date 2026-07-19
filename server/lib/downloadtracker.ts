import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import { MediaType } from '@server/constants/media';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { uniqWith } from 'lodash';

interface EpisodeNumberResult {
  seasonNumber: number;
  episodeNumber: number;
  absoluteEpisodeNumber: number;
  id: number;
}

// A download that hasn't advanced (sizeLeft unchanged) for this long is
// considered stalled.
export const STALL_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours

export interface DownloadingItem {
  mediaType: MediaType;
  externalId: number;
  size: number;
  sizeLeft: number;
  status: string;
  timeLeft: string;
  estimatedCompletionTime: Date;
  title: string;
  downloadId: string;
  episode?: EpisodeNumberResult;
  // Radarr/Sonarr's own queue-item status. 'warning'/'error' generally means
  // an import failure (e.g. no files eligible for import).
  trackedDownloadStatus?: string;
  trackedDownloadState?: string;
  statusMessages?: {
    title?: string;
    messages?: string[];
  }[];
  // Last time this item's sizeLeft changed across download-sync polls, and
  // whether that's now >= STALL_THRESHOLD_MS ago.
  lastProgressChangeAt?: Date;
  isStalled?: boolean;
}

class DownloadTracker {
  private radarrServers: Record<number, DownloadingItem[]> = {};
  private sonarrServers: Record<number, DownloadingItem[]> = {};

  // Keyed by `${radarr|sonarr}-${serverId}-${downloadId}`. Used to derive
  // isStalled/lastProgressChangeAt across successive download-sync polls.
  private progressHistory: Record<
    string,
    { sizeLeft: number; lastChanged: number }
  > = {};

  // Keyed by `${mediaId}-${std|4k}`. Set by the stale-request sweep job when
  // a request has been approved and sent to Radarr/Sonarr but nothing has
  // ever shown up in the queue. Cleared once the item shows up or the media
  // is no longer PROCESSING.
  private neverFoundMedia: Record<string, Date> = {};

  public getMovieProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    if (!this.radarrServers[serverId]) {
      return [];
    }

    return this.radarrServers[serverId].filter(
      (item) => item.externalId === externalServiceId
    );
  }

  public getSeriesProgress(
    serverId: number,
    externalServiceId: number
  ): DownloadingItem[] {
    if (!this.sonarrServers[serverId]) {
      return [];
    }

    return this.sonarrServers[serverId].filter(
      (item) => item.externalId === externalServiceId
    );
  }

  public async resetDownloadTracker() {
    this.radarrServers = {};
    this.sonarrServers = {};
  }

  public updateDownloads() {
    this.updateRadarrDownloads();
    this.updateSonarrDownloads();
  }

  public setNeverFound(mediaId: number, is4k: boolean, since: Date): void {
    this.neverFoundMedia[`${mediaId}-${is4k ? '4k' : 'std'}`] = since;
  }

  public clearNeverFound(mediaId: number, is4k: boolean): void {
    delete this.neverFoundMedia[`${mediaId}-${is4k ? '4k' : 'std'}`];
  }

  public getNeverFound(mediaId: number, is4k: boolean): Date | undefined {
    return this.neverFoundMedia[`${mediaId}-${is4k ? '4k' : 'std'}`];
  }

  /**
   * Records the current sizeLeft for a queue item and reports whether it has
   * been unchanged for at least STALL_THRESHOLD_MS.
   */
  private trackProgress(
    key: string,
    sizeLeft: number
  ): { isStalled: boolean; lastChanged: Date } {
    const now = Date.now();
    const previous = this.progressHistory[key];

    if (!previous || previous.sizeLeft !== sizeLeft) {
      this.progressHistory[key] = { sizeLeft, lastChanged: now };
      return { isStalled: false, lastChanged: new Date(now) };
    }

    return {
      isStalled: now - previous.lastChanged >= STALL_THRESHOLD_MS,
      lastChanged: new Date(previous.lastChanged),
    };
  }

  /**
   * Drops progress history entries that are no longer present in the latest
   * queue poll for a given server, so the map doesn't grow unbounded as
   * downloads complete or get removed from the queue.
   */
  private pruneProgressHistory(
    keyPrefix: string,
    activeKeys: Set<string>
  ): void {
    Object.keys(this.progressHistory).forEach((key) => {
      if (key.startsWith(keyPrefix) && !activeKeys.has(key)) {
        delete this.progressHistory[key];
      }
    });
  }

  private async updateRadarrDownloads() {
    const settings = getSettings();

    // Remove duplicate servers
    const filteredServers = uniqWith(settings.radarr, (radarrA, radarrB) => {
      return (
        radarrA.hostname === radarrB.hostname &&
        radarrA.port === radarrB.port &&
        radarrA.baseUrl === radarrB.baseUrl
      );
    });

    // Load downloads from Radarr servers
    Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const radarr = new RadarrAPI({
            apiKey: server.apiKey,
            url: RadarrAPI.buildUrl(server, '/api/v3'),
          });

          try {
            await radarr.refreshMonitoredDownloads();
            const queueItems = await radarr.getQueue();
            const activeProgressKeys = new Set<string>();

            this.radarrServers[server.id] = queueItems.map((item) => {
              const progressKey = `radarr-${server.id}-${item.downloadId}`;
              activeProgressKeys.add(progressKey);
              const progress = this.trackProgress(progressKey, item.sizeleft);

              return {
                externalId: item.movieId,
                estimatedCompletionTime: new Date(
                  item.estimatedCompletionTime
                ),
                mediaType: MediaType.MOVIE,
                size: item.size,
                sizeLeft: item.sizeleft,
                status: item.status,
                timeLeft: item.timeleft,
                title: item.title,
                downloadId: item.downloadId,
                trackedDownloadStatus: item.trackedDownloadStatus,
                trackedDownloadState: item.trackedDownloadState,
                statusMessages: item.statusMessages,
                lastProgressChangeAt: progress.lastChanged,
                isStalled: progress.isStalled,
              };
            });
            this.pruneProgressHistory(
              `radarr-${server.id}-`,
              activeProgressKeys
            );

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Radarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }
          } catch {
            logger.error(
              `Unable to get queue from Radarr server: ${server.name}`,
              {
                label: 'Download Tracker',
              }
            );
          }

          // Duplicate this data to matching servers
          const matchingServers = settings.radarr.filter(
            (rs) =>
              rs.hostname === server.hostname &&
              rs.port === server.port &&
              rs.baseUrl === server.baseUrl &&
              rs.id !== server.id
          );

          if (matchingServers.length > 0) {
            logger.debug(
              `Matching download data to ${matchingServers.length} other Radarr server(s)`,
              { label: 'Download Tracker' }
            );
          }

          matchingServers.forEach((ms) => {
            if (ms.syncEnabled) {
              this.radarrServers[ms.id] = this.radarrServers[server.id];
            }
          });
        }
      })
    );
  }

  private async updateSonarrDownloads() {
    const settings = getSettings();

    // Remove duplicate servers
    const filteredServers = uniqWith(settings.sonarr, (sonarrA, sonarrB) => {
      return (
        sonarrA.hostname === sonarrB.hostname &&
        sonarrA.port === sonarrB.port &&
        sonarrA.baseUrl === sonarrB.baseUrl
      );
    });

    // Load downloads from Sonarr servers
    Promise.all(
      filteredServers.map(async (server) => {
        if (server.syncEnabled) {
          const sonarr = new SonarrAPI({
            apiKey: server.apiKey,
            url: SonarrAPI.buildUrl(server, '/api/v3'),
          });

          try {
            await sonarr.refreshMonitoredDownloads();
            const queueItems = await sonarr.getQueue();
            const activeProgressKeys = new Set<string>();

            this.sonarrServers[server.id] = queueItems.map((item) => {
              const progressKey = `sonarr-${server.id}-${item.downloadId}`;
              activeProgressKeys.add(progressKey);
              const progress = this.trackProgress(progressKey, item.sizeleft);

              return {
                externalId: item.seriesId,
                estimatedCompletionTime: new Date(
                  item.estimatedCompletionTime
                ),
                mediaType: MediaType.TV,
                size: item.size,
                sizeLeft: item.sizeleft,
                status: item.status,
                timeLeft: item.timeleft,
                title: item.title,
                episode: item.episode,
                downloadId: item.downloadId,
                trackedDownloadStatus: item.trackedDownloadStatus,
                trackedDownloadState: item.trackedDownloadState,
                statusMessages: item.statusMessages,
                lastProgressChangeAt: progress.lastChanged,
                isStalled: progress.isStalled,
              };
            });
            this.pruneProgressHistory(
              `sonarr-${server.id}-`,
              activeProgressKeys
            );

            if (queueItems.length > 0) {
              logger.debug(
                `Found ${queueItems.length} item(s) in progress on Sonarr server: ${server.name}`,
                { label: 'Download Tracker' }
              );
            }
          } catch {
            logger.error(
              `Unable to get queue from Sonarr server: ${server.name}`,
              {
                label: 'Download Tracker',
              }
            );
          }

          // Duplicate this data to matching servers
          const matchingServers = settings.sonarr.filter(
            (ss) =>
              ss.hostname === server.hostname &&
              ss.port === server.port &&
              ss.baseUrl === server.baseUrl &&
              ss.id !== server.id
          );

          if (matchingServers.length > 0) {
            logger.debug(
              `Matching download data to ${matchingServers.length} other Sonarr server(s)`,
              { label: 'Download Tracker' }
            );
          }

          matchingServers.forEach((ms) => {
            if (ms.syncEnabled) {
              this.sonarrServers[ms.id] = this.sonarrServers[server.id];
            }
          });
        }
      })
    );
  }
}

const downloadTracker = new DownloadTracker();

export default downloadTracker;
