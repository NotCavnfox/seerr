import assert from 'node:assert/strict';
import { after, beforeEach, describe, it, mock } from 'node:test';

import JellyfinAPI, { type JellyfinLoginResponse } from '@server/api/jellyfin';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import { quickConnectAuthLimiter } from '@server/middleware/quickConnectAuthLimiter';
import { setupTestDb } from '@server/test/db';
import { ApiError } from '@server/types/error';
import express from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import session from 'express-session';
import request from 'supertest';
import authRoutes from './auth';
import userRoutes from './user';

const loginPath = '/auth/jellyfin/quickconnect/authenticate';
const linkPath = '/user/1/settings/linked-accounts/jellyfin/quickconnect';
const secret = 'abcdef0123456789';
const account: JellyfinLoginResponse = {
  User: {
    Id: 'quick-connect-test-user',
    Name: 'test-user',
    ServerId: 'test-server',
    ServerName: 'test-server',
    Configuration: { GroupedFolders: [] },
    Policy: { IsAdministrator: false },
  },
  AccessToken: 'synthetic-test-token',
};

let allowAuthentication = false;
const authenticate = mock.method(
  JellyfinAPI.prototype,
  'authenticateQuickConnect',
  async () => {
    if (!allowAuthentication) {
      throw new ApiError(401, ApiErrorCode.InvalidCredentials);
    }
    return account;
  }
);
const check = mock.method(
  JellyfinAPI.prototype,
  'checkQuickConnect',
  async () => ({
    Authenticated: false,
  })
);

function createApp(userId?: number) {
  const app = express();
  app.enable('trust proxy');
  app.use(express.json());
  app.use(
    session({
      secret: 'synthetic-test-session',
      resave: false,
      saveUninitialized: false,
      cookie: { secure: true },
    })
  );
  app.use(async (req, _res, next) => {
    if (userId) {
      req.user = await getRepository(User).findOneByOrFail({ id: userId });
    }
    next();
  });
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res.status(err.status ?? 500).json({ message: err.message });
    }
  );
  return app;
}

setupTestDb();
beforeEach(() => {
  allowAuthentication = false;
  authenticate.mock.resetCalls();
  check.mock.resetCalls();
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) {
    quickConnectAuthLimiter.resetKey(ipKeyGenerator(ip));
  }
  getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
});
after(() => mock.restoreAll());

describe('Quick Connect authentication budget', () => {
  it('shares failed-attempt limits across login/link and ignores spoofed forwarded IPs', async () => {
    const app = createApp(1);
    for (let index = 0; index < 50; index++) {
      const response = await request(app)
        .post(index % 2 ? linkPath : loginPath)
        .set('X-Forwarded-For', `192.0.2.${index + 1}`)
        .send({ secret: index % 2 ? secret.toUpperCase() : secret });
      assert.equal(response.status, 401);
    }
    assert.equal(authenticate.mock.callCount(), 50);
    for (const path of [loginPath, linkPath]) {
      const response = await request(app)
        .post(path)
        .set('X-Forwarded-For', '198.51.100.42')
        .send({ secret });
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers['retry-after']) > 0);
    }
    assert.equal(authenticate.mock.callCount(), 50);
    const poll = await request(app)
      .get('/auth/jellyfin/quickconnect/check')
      .query({ secret });
    assert.equal(poll.status, 200);
    assert.equal(poll.body.authenticated, false);
    assert.equal(check.mock.callCount(), 1);
  });

  it('preserves normal sign-in and user identity', async () => {
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    user.jellyfinUserId = account.User.Id;
    await getRepository(User).save(user);
    allowAuthentication = true;
    const response = await request(createApp())
      .post(loginPath)
      .send({ secret });
    assert.equal(response.status, 200);
    assert.equal(response.body.id, user.id);
    assert.equal(authenticate.mock.callCount(), 1);
  });

  it('preserves own-profile linking and stores the authenticated account', async () => {
    allowAuthentication = true;
    const response = await request(createApp(1))
      .post(linkPath)
      .send({ secret });
    assert.equal(response.status, 204);
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    assert.equal(user.jellyfinUserId, account.User.Id);
    assert.equal(authenticate.mock.callCount(), 1);
  });

  it('preserves authentication, ownership and malformed-secret rejection', async () => {
    for (const userId of [undefined, 2]) {
      const response = await request(createApp(userId))
        .post(linkPath)
        .send({ secret });
      assert.equal(response.status, 403);
    }
    for (const path of [loginPath, linkPath]) {
      const response = await request(createApp(1))
        .post(path)
        .send({ secret: ['abcdef01'] });
      assert.equal(response.status, 400);
    }
    assert.equal(authenticate.mock.callCount(), 0);
  });
});
