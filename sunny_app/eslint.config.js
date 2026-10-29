// eslint.config.js
//
// Purpose: ESLint flat config for sunny_app: Expo's recommended rules with Prettier
// owning formatting. Run with `npm run lint`; pre-commit runs it too.

const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

module.exports = defineConfig([
  expoConfig,
  prettierConfig,
  {
    ignores: ['ios/*', 'android/*', 'dist/*', '.expo/*', 'node_modules/*'],
  },
]);
