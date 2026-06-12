// src/theme.ts  —  Light + Dark theme definitions

import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Colour palettes ──────────────────────────────────────────────────────────
export const darkColors = {
  bg:           '#0d0d1a',
  bg2:          '#141428',
  bg3:          '#1a1a35',
  bg4:          '#22223d',
  bg5:          '#2a2a4a',
  bgCard:       '#1a1a35',
  bgElevated:   '#22223d',
  text:         '#e2e2f0',
  textSecondary:'#a0a0c0',
  textMuted:    '#606080',
  border:       '#2a2a50',
  borderLight:  '#38385a',
  accent:       '#7c5cfc',
  accent2:      '#00d4ff',
  accentGreen:  '#00e5a0',
  accentRed:    '#ff4d6a',
  accentYellow: '#ffb547',
  url:          '#9ea0ff',
  userBubble:   '#7c5cfc',
  aiBubble:     '#1a1a35',
  aiBubbleBorder:'#2a2a50',
  inputBg:      '#141428',
  shadowColor:  '#000',
};

export const lightColors = {
  bg:           '#f4f4ff',
  bg2:          '#ffffff',
  bg3:          '#f0f0f8',
  bg4:          '#e8e8f4',
  bg5:          '#dcdcee',
  bgCard:       '#ffffff',
  bgElevated:   '#f0f0f8',
  text:         '#1a1a30',
  textSecondary:'#50508a',
  textMuted:    '#9090b0',
  border:       '#d4d4e8',
  borderLight:  '#c8c8e0',
  accent:       '#6040e8',
  accent2:      '#0088cc',
  accentGreen:  '#00aa70',
  accentRed:    '#cc2244',
  accentYellow: '#cc8800',
  url:          '#5040c0',
  userBubble:   '#6040e8',
  aiBubble:     '#f0f0fa',
  aiBubbleBorder:'#d0d0ea',
  inputBg:      '#f8f8ff',
  shadowColor:  '#00006020',
};

export type ThemeColors = typeof darkColors;
export type ThemeMode   = 'dark' | 'light';

// ─── Theme context ────────────────────────────────────────────────────────────
interface ThemeCtx {
  mode:        ThemeMode;
  colors:      ThemeColors;
  toggleTheme: () => void;
  isDark:      boolean;
}

const ThemeContext = createContext<ThemeCtx>({
  mode:        'light',
  colors:      lightColors,
  toggleTheme: () => {},
  isDark:      false,
});

const THEME_KEY = '@lance_theme';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('light');

  useEffect(() => {
    AsyncStorage.getItem(THEME_KEY)
      .then(v => { if (v === 'light' || v === 'dark') setMode(v); })
      .catch(() => {});
  }, []);

  const toggleTheme = () => {
    const next = mode === 'dark' ? 'light' : 'dark';
    setMode(next);
    AsyncStorage.setItem(THEME_KEY, next).catch(() => {});
  };

  const colors = mode === 'dark' ? darkColors : lightColors;

  return (
    <ThemeContext.Provider value={{ mode, colors, toggleTheme, isDark: mode === 'dark' }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeCtx {
  return useContext(ThemeContext);
}
