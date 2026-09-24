import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// Share the authentication budget between sign-in and account linking, not polling.
export const quickConnectAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 50,
  // trustProxy can be boolean true, so forwarded headers are not a safe identity.
  // Clients behind the same reverse proxy share this transport-peer allowance.
  keyGenerator: (req) =>
    req.socket.remoteAddress
      ? ipKeyGenerator(req.socket.remoteAddress)
      : 'unknown-peer',
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many Quick Connect attempts. Try again later.' },
});
