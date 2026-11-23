import { ClerkProvider, useAuth } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { convex } from './src/backend/convex';
import type { PairedDevice, SessionDecision } from './src/backend/pairing';
import { useSession } from './src/backend/useSession';
import { CaregiverApp } from './src/caregiver/CaregiverApp';
import { Banner } from './src/components/Banner';
import { CLERK_PUBLISHABLE_KEY } from './src/config';
import { dropLegacyPressQueue } from './src/day/legacyQueue';
import { useDayView } from './src/day/useDayView';
import { CaregiverOnboardingScreen } from './src/screens/CaregiverOnboardingScreen';
import { ConfigErrorScreen } from './src/screens/ConfigErrorScreen';
import { TuningProvider } from './src/display/TuningProvider';
import { DevTools } from './src/screens/DevTools';
import { DisplayScreen } from './src/screens/DisplayScreen';
import { SignedOutFlow } from './src/screens/SignedOutFlow';
import { TodayScreen } from './src/screens/TodayScreen';
import { BACKGROUND, colors } from './src/theme/colors';
import { ThemeProvider } from './src/theme/ThemeProvider';
import { ConversationScreen } from './src/voice/ConversationScreen';
import { useVoice, VoiceProvider } from './src/voice/VoiceProvider';
import { useSurfaceSync, useWidgetSync } from './src/widget/useWidgetSync';

function PairedHome({ paired }: { paired: PairedDevice }) {
  const voice = useVoice();
  const dayView = useDayView(paired.householdId);
  useSurfaceSync(paired.kind === 'senior_phone' ? dayView.day : null);
  if (paired.kind === 'home_display') return <DisplayScreen dayView={dayView} />;
  if (voice.isInteractive) return <ConversationScreen />;
  return <TodayScreen dayView={dayView} />;
}

function isHomeDisplay(decision: SessionDecision): boolean {
  return decision.state === 'paired' && decision.device.kind === 'home_display';
}

function Banners({ voiceBanners }: { voiceBanners: boolean }) {
  const voice = useVoice();
  const insets = useSafeAreaInsets();
  const top = insets.top + (__DEV__ ? 40 : 4);
  return (
    <View pointerEvents="box-none" style={[styles.banners, { top }]}>
      {voiceBanners && voice.connectionState === 'reconnecting' && (
        <Banner tone="moderate" title="Warning" message="Trying to reconnect" />
      )}
      {voiceBanners && voice.error !== null && (
        <Banner tone="serious" title="Error" message={voice.error} onDismiss={voice.clearError} />
      )}
    </View>
  );
}

function SessionScreen({ decision }: { decision: SessionDecision }) {
  switch (decision.state) {
    case 'paired':
      return <PairedHome key={decision.device.householdId} paired={decision.device} />;
    case 'caregiver':
      return (
        <CaregiverApp
          key={decision.home.householdId}
          householdId={decision.home.householdId}
          role={decision.home.role}
        />
      );
    case 'caregiverOnboarding':
      return <CaregiverOnboardingScreen />;
    default:
      return <SignedOutFlow />;
  }
}

function Shell({ decision }: { decision: SessionDecision }) {
  return (
    <View style={styles.root}>
      <SessionScreen decision={decision} />
      <Banners voiceBanners={!isHomeDisplay(decision)} />
      {__DEV__ && <DevTools display={isHomeDisplay(decision)} />}
    </View>
  );
}

function LoadingView({ notice }: { notice?: string }) {
  return (
    <View style={[styles.root, styles.loading]}>
      <Text style={styles.loadingText}>Connecting...</Text>
      {notice !== undefined && <Text style={styles.loadingNotice}>{notice}</Text>}
    </View>
  );
}

function Root() {
  const decision = useSession();
  useWidgetSync(decision);
  if (decision.state === 'loading') return <LoadingView notice={decision.notice} />;
  if (decision.state === 'removed') return <LoadingView />;
  const paired = decision.state === 'paired' ? decision.device : null;
  return (
    <VoiceProvider pairedDevice={paired}>
      <Shell decision={decision} />
    </VoiceProvider>
  );
}

function BackendProviders() {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <Root />
      </ConvexProviderWithClerk>
    </ClerkProvider>
  );
}

export default function App() {
  useEffect(() => {
    void dropLegacyPressQueue();
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <TuningProvider>
          <StatusBar style="dark" />
          {CLERK_PUBLISHABLE_KEY === '' ? <ConfigErrorScreen /> : <BackendProviders />}
        </TuningProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BACKGROUND },
  loading: { alignItems: 'center', justifyContent: 'center' },
  loadingText: { fontSize: 20, color: colors.secondaryText },
  loadingNotice: { marginTop: 8, fontSize: 16, color: colors.secondaryText },
  banners: { position: 'absolute', left: 0, right: 0, gap: 8 },
});
