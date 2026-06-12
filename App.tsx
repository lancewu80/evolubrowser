import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from './src/theme';
import BrowserScreen from './src/screens/BrowserScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <BrowserScreen />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
