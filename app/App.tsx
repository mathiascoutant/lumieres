import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { loadServerUrl } from './src/lib/api';
import { connect, disconnect } from './src/lib/store';
import { Shell } from './src/Shell';

export default function App() {
  useEffect(() => {
    loadServerUrl().then(connect);
    // iOS suspends sockets in the background: reconnect straight away on return.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') connect();
    });
    return () => {
      sub.remove();
      disconnect();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Shell />
    </SafeAreaProvider>
  );
}
