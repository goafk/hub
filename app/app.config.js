// The Firebase config (google-services.json) isn't in the repo: EAS builds get it from the secret
// file variable GOOGLE_SERVICES_JSON; local builds use ./google-services.json.
module.exports = ({ config }) => ({
  ...config,
  android: { ...config.android, googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json" },
});
