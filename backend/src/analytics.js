const logger = require('./logger');

// Analytics event tracker — wires to PostHog when POSTHOG_API_KEY is set,
// otherwise emits structured log events (same schema, zero-cost fallback).
let posthog = null;
if (process.env.POSTHOG_API_KEY && process.env.POSTHOG_HOST) {
  try {
    const { PostHog } = require('posthog-node');
    posthog = new PostHog(process.env.POSTHOG_API_KEY, {
      host: process.env.POSTHOG_HOST || 'https://app.posthog.com',
    });
    logger.info('Analytics: PostHog connected', { host: process.env.POSTHOG_HOST });
  } catch (err) {
    logger.warn('Analytics: PostHog init failed, falling back to log events', { err: err.message });
  }
}

function track(event, userId, properties = {}) {
  const payload = { event, distinctId: userId || 'anonymous', properties, ts: new Date().toISOString() };
  if (posthog) {
    posthog.capture({ distinctId: userId || 'anonymous', event, properties });
  }
  // Always log so events are visible in structured logs regardless of PostHog status
  logger.info('analytics.event', payload);
}

function trackApiCall(route, method, userId, durationMs, statusCode) {
  track('api_call', userId, { route, method, durationMs, statusCode });
}

function shutdown() {
  if (posthog) return posthog.shutdown();
  return Promise.resolve();
}

module.exports = { track, trackApiCall, shutdown };
