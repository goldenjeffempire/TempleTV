import * as Sentry from "@sentry/node";

const dsn =
  process.env.SENTRY_DSN ??
  "https://e1d80a0a1acfca1dc8743cc701de446c@o4511258419462144.ingest.us.sentry.io/4511258444693504";

const environment = process.env.NODE_ENV ?? "development";
const release = process.env.SENTRY_RELEASE ?? process.env.RENDER_GIT_COMMIT;

Sentry.init({
  dsn,
  environment,
  release,
  sendDefaultPii: true,
  tracesSampleRate: environment === "production" ? 0.1 : 1.0,
  profilesSampleRate: environment === "production" ? 0.1 : 1.0,
});
