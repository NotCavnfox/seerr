// Run with Node 22: node --test test/request-card-status.test.cjs
// Render the real request components and StatusBadge; isolate network/layout hooks.
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('ts-node').register({
  project: './tsconfig.json',
  transpileOnly: true,
  compilerOptions: { module: 'commonjs', moduleResolution: 'node' },
});
require('tsconfig-paths/register');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { IntlProvider } = require('react-intl');
const messages = require('../src/i18n/locale/en.json');
const {
  MediaStatus,
  MediaRequestStatus,
} = require('../server/constants/media');
const element = React.createElement;
const empty = () => null;
let scenario;

// Stub external dependencies only; require the actual components below. Node's
// test runner isolates this file's require cache from other test files.
function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = {
    id,
    filename: id,
    loaded: true,
    exports: { __esModule: true, ...exports },
  };
}
function mockDefault(path, component) {
  stub(path, { default: component });
}
mockDefault('@app/assets/spinner.svg', empty);
mockDefault('@app/hooks/useSettings', () => ({ currentSettings: {} }));
mockDefault('@app/hooks/useDeepLinks', () => ({}));
mockDefault('@app/hooks/useToasts', () => ({ addToast: empty }));
stub('@app/hooks/useUser', {
  Permission: {},
  useUser: () => ({ hasPermission: () => false, user: { id: 2 } }),
});
stub('react-intersection-observer', {
  useInView: () => ({ ref: null, inView: true }),
});
stub('swr', {
  default: (url) => ({
    data: url?.includes('/request/') ? scenario.request : scenario.title,
    error: url?.includes('/request/') ? undefined : scenario.error,
    mutate: empty,
  }),
  mutate: empty,
});
for (const path of [
  '@app/components/RequestModal',
  '@app/components/DownloadBlock',
  '@app/components/Common/CachedImage',
  '@app/components/Common/ConfirmButton',
]) {
  mockDefault(path, empty);
}
mockDefault('next/link', ({ children }) => element('a', null, children));
mockDefault('@app/components/Common/Button', ({ children }) =>
  element('button', null, children)
);
mockDefault('@app/components/Common/Badge', ({ children }) =>
  element('span', { 'data-status': true }, children)
);
mockDefault('@app/components/Common/Tooltip', ({ children, content }) =>
  element(
    React.Fragment,
    null,
    children,
    element('aside', { 'data-tooltip': true }, content)
  )
);
const RequestCard = require('../src/components/RequestCard').default;
const RequestItem =
  require('../src/components/RequestList/RequestItem').default;
const StatusBadge = require('../src/components/StatusBadge').default;

function fixture(is4k, error = false) {
  return {
    title: error
      ? undefined
      : { title: 'Synthetic Movie', releaseDate: '2026-01-01' },
    error: error ? new Error('Synthetic title unavailable') : undefined,
    request: {
      id: 1,
      type: 'movie',
      is4k,
      status: MediaRequestStatus.APPROVED,
      requestedBy: { id: 2 },
      seasons: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      media: {
        id: 3,
        tmdbId: 4,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.PROCESSING,
        downloadStatus: [],
        downloadStatus4k: [],
      },
    },
  };
}
function render(component, props) {
  return renderToStaticMarkup(
    element(IntlProvider, { locale: 'en', messages }, element(component, props))
  );
}
function badges(html) {
  return [...html.matchAll(/<span data-status="true">(.*?)<\/span>/g)].map(
    (match) => match[1].replace(/<[^>]*>/g, '')
  );
}
function selected() {
  const { media, is4k } = scenario.request;
  const downloadItem = media[is4k ? 'downloadStatus4k' : 'downloadStatus'];
  return {
    status: media[is4k ? 'status4k' : 'status'],
    downloadItem,
    neverFoundSince: media[is4k ? 'neverFoundSince4k' : 'neverFoundSince'],
    is4k,
    inProgress: downloadItem.length > 0,
  };
}
for (const Component of [RequestCard, RequestItem]) {
  for (const is4k of [false, true]) {
    for (const error of [false, true]) {
      test(`${Component.name}: ${is4k ? '4K' : 'standard'} ${error ? 'missing title' : 'loaded title'} agrees with detail status`, () => {
        scenario = fixture(is4k, error);
        scenario.request.media[is4k ? 'neverFoundSince4k' : 'neverFoundSince'] =
          new Date(Date.now() - 18 * 3600000);
        const card = render(Component, { request: scenario.request });
        assert.deepEqual(badges(card), badges(render(StatusBadge, selected())));
        assert.deepEqual(badges(card), [is4k ? '4K Not Found' : 'Not Found']);
        assert.match(
          card,
          /No active download is currently reported for this request/
        );
        assert.match(card, /A suitable copy may not be available/);
        assert.match(card, /First noticed/);
        assert.doesNotMatch(card, /Approved 18 hours/);
      });
    }
    test(`${Component.name}: ${is4k ? '4K' : 'standard'} ignores the other quality's flag`, () => {
      scenario = fixture(is4k);
      scenario.request.media[is4k ? 'neverFoundSince' : 'neverFoundSince4k'] =
        new Date();
      assert.deepEqual(
        badges(render(Component, { request: scenario.request })),
        [is4k ? '4K Requested' : 'Requested']
      );
    });
    test(`${Component.name}: queue issues and available/pending states retain precedence`, () => {
      scenario = fixture(is4k);
      const media = scenario.request.media;
      const statusKey = is4k ? 'status4k' : 'status';
      const queueKey = is4k ? 'downloadStatus4k' : 'downloadStatus';
      media[is4k ? 'neverFoundSince4k' : 'neverFoundSince'] = new Date();
      const prefix = is4k ? '4K ' : '';
      for (const [item, expected] of [
        [
          { trackedDownloadStatus: 'warning', isStalled: true },
          'Import Failed',
        ],
        [{ isStalled: true, lastProgressChangeAt: new Date() }, 'Stalled'],
        [{ size: 100, sizeLeft: 50 }, 'Processing'],
      ]) {
        media[queueKey] = [item];
        const card = render(Component, { request: scenario.request });
        assert.deepEqual(badges(card), [prefix + expected]);
        assert.deepEqual(badges(card), badges(render(StatusBadge, selected())));
      }
      media[queueKey] = [];
      for (const [status, expected] of [
        [MediaStatus.AVAILABLE, 'Available'],
        [MediaStatus.PENDING, 'Pending'],
      ]) {
        media[statusKey] = status;
        assert.deepEqual(
          badges(render(Component, { request: scenario.request })),
          [prefix + expected]
        );
      }
      for (const [status, expected] of [
        [MediaRequestStatus.DECLINED, 'Declined'],
        [MediaRequestStatus.FAILED, 'Failed'],
      ]) {
        media[statusKey] = MediaStatus.PROCESSING;
        scenario.request.status = status;
        assert.deepEqual(
          badges(render(Component, { request: scenario.request })),
          [expected]
        );
      }
      scenario.request.status = MediaRequestStatus.PENDING;
      media[statusKey] = MediaStatus.DELETED;
      assert.deepEqual(
        badges(render(Component, { request: scenario.request })),
        ['Pending']
      );
    });
  }
}
