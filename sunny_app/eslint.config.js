const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

const NODE_SCRIPT_GLOBALS = { Buffer: 'readonly', __dirname: 'readonly' };

module.exports = defineConfig([
  expoConfig,
  prettierConfig,
  {
    files: ['scripts/**/*.js'],
    languageOptions: { globals: NODE_SCRIPT_GLOBALS },
  },
  {
    ignores: ['ios/*', 'android/*', 'dist/*', '.expo/*', 'node_modules/*'],
  },
]);
