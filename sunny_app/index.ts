// index.ts
//
// Purpose: App entry point. Registers LiveKit's React Native globals (WebRTC, audio session
// management, polyfills), which must run before any LiveKit code, then registers the root
// component for Expo.
//
// Last modified: 2026-10-28

import { registerGlobals } from '@livekit/react-native';
import { registerRootComponent } from 'expo';

import App from './App';

registerGlobals();

registerRootComponent(App);
