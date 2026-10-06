// react-native-worklets' Babel plugin has to be LAST in the plugin list, and
// it is what makes Reanimated 4 and react-native-keyboard-controller work at
// all — both compile their callbacks into worklets. Without it the app still
// passes jest (which never runs the plugin) and then crashes on device the
// first time KeyboardProvider mounts, so this file is load-bearing despite
// looking like boilerplate.
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
