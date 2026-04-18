const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

const replitDomain = process.env.REPLIT_DEV_DOMAIN;
const replitExpoDomain = process.env.REPLIT_EXPO_DEV_DOMAIN;

const allowedDomains = [replitDomain, replitExpoDomain].filter(Boolean);

if (allowedDomains.length > 0) {
  const originalEnhance = config.server?.enhanceMiddleware;

  config.server = config.server ?? {};
  config.server.enhanceMiddleware = (middleware) => {
    const enhanced = originalEnhance ? originalEnhance(middleware) : middleware;

    return (req, res, next) => {
      const origin = req.headers["origin"];
      if (origin && allowedDomains.some((d) => origin.includes(d))) {
        delete req.headers["origin"];
      }
      enhanced(req, res, next);
    };
  };
}

module.exports = config;
