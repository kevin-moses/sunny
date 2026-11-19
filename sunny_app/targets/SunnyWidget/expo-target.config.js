const APP_GROUP = 'group.com.kmsunny.sunny';
const KEYCHAIN_GROUP = '$(AppIdentifierPrefix)com.kmsunny.sunny.shared';

module.exports = (config) => ({
  type: 'widget',
  name: 'SunnyWidget',
  displayName: 'Sunny',
  bundleIdentifier: '.widget',
  deploymentTarget: '17.2',
  appleTeamId: config.ios.appleTeamId,
  frameworks: ['SwiftUI', 'WidgetKit', 'AppIntents'],
  entitlements: {
    'com.apple.security.application-groups': [APP_GROUP],
    'keychain-access-groups': [KEYCHAIN_GROUP],
  },
});
