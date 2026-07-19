import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MediaRequest from '@server/entity/MediaRequest';
import downloadTracker from '@server/lib/downloadtracker';
import logger from '@server/logger';

// How long a request can sit APPROVED (sent to Radarr/Sonarr) without ever
// showing up in that server's download queue before we flag it as "never
// found" for the UI.
export const NEVER_FOUND_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Sweeps PENDING/APPROVED requests looking for ones whose media was sent to
 * Radarr/Sonarr but never showed any activity in the download queue
 * (download-sync's per-minute poll never saw it) and has no file, more than
 * NEVER_FOUND_THRESHOLD_MS after approval. Flags matches via
 * downloadTracker.setNeverFound so StatusBadge can surface them instead of a
 * static "Requested" label forever.
 *
 * This intentionally does not touch MediaStatus — the media stays
 * PROCESSING, we're only attaching extra "something's wrong" detail for the
 * UI to read.
 */
class StaleRequestSync {
  public running = false;

  public async run() {
    this.running = true;

    try {
      logger.info('Starting stale request sync...', {
        label: 'StaleRequestSync',
      });

      const requestRepository = getRepository(MediaRequest);
      const requests = await requestRepository.find({
        where: [
          { status: MediaRequestStatus.APPROVED },
          { status: MediaRequestStatus.PENDING },
        ],
      });

      const now = Date.now();

      for (const request of requests) {
        if (!this.running) {
          throw new Error('Job aborted');
        }

        const media = request.media;
        const statusKey = request.is4k ? 'status4k' : 'status';
        const serviceIdKey = request.is4k ? 'serviceId4k' : 'serviceId';
        const externalIdKey = request.is4k
          ? 'externalServiceId4k'
          : 'externalServiceId';

        // Only requests actually sent to Radarr/Sonarr and still sitting in
        // PROCESSING are candidates. Anything else (still awaiting approval,
        // already available, deleted, etc.) isn't our concern here.
        if (media[statusKey] !== MediaStatus.PROCESSING) {
          downloadTracker.clearNeverFound(media.id, request.is4k);
          continue;
        }

        const serviceId = media[serviceIdKey];
        const externalId = media[externalIdKey];

        if (
          serviceId === null ||
          serviceId === undefined ||
          externalId === null ||
          externalId === undefined
        ) {
          // Not sent to Radarr/Sonarr yet (add call still in flight from the
          // request subscriber) — nothing to flag.
          continue;
        }

        const queueItems =
          media.mediaType === MediaType.MOVIE
            ? downloadTracker.getMovieProgress(serviceId, externalId)
            : downloadTracker.getSeriesProgress(serviceId, externalId);

        if (queueItems.length > 0) {
          // It has shown up in the queue at least once since the last
          // download-sync poll — not "never found".
          downloadTracker.clearNeverFound(media.id, request.is4k);
          continue;
        }

        // `updatedAt` is bumped whenever the request is saved, which
        // includes the transition to APPROVED performed by the
        // approval endpoint / auto-approve. Using it as a stand-in for
        // "approved at" avoids needing a dedicated column for this.
        const approvedAt = request.updatedAt.getTime();

        if (now - approvedAt < NEVER_FOUND_THRESHOLD_MS) {
          continue;
        }

        if (!downloadTracker.getNeverFound(media.id, request.is4k)) {
          logger.info(
            `Request for media [TMDB ID ${media.tmdbId}] has not entered the download queue ${
              NEVER_FOUND_THRESHOLD_MS / (60 * 60 * 1000)
            }h after approval. Flagging as never found.`,
            {
              label: 'StaleRequestSync',
              requestId: request.id,
              mediaId: media.id,
            }
          );
          downloadTracker.setNeverFound(media.id, request.is4k, new Date());
        }
      }
    } catch (ex) {
      logger.error('Failed to complete stale request sync.', {
        errorMessage: ex.message,
        label: 'StaleRequestSync',
      });
    } finally {
      logger.info('Stale request sync complete.', {
        label: 'StaleRequestSync',
      });
      this.running = false;
    }
  }

  public cancel() {
    this.running = false;
  }
}

const staleRequestSync = new StaleRequestSync();

export default staleRequestSync;
