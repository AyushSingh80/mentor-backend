const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Let Metro resolve the .sql migration files that babel-plugin-inline-import
// pulls into the bundle.
config.resolver.sourceExts.push('sql');

module.exports = config;
