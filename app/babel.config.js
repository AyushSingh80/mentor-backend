module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Drizzle's Expo migrator imports .sql files directly; this inlines them
      // into the bundle so migrations ship with the app.
      ['inline-import', { extensions: ['.sql'] }],
    ],
  };
};
