/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        serif: ['Lora', 'Georgia', 'serif'],
        mono:  ['"IBM Plex Mono"', 'monospace'],
        sans:  ['Syne', 'sans-serif'],
      },
      colors: {
        bg:           '#f8f9fc',
        surface:      '#eef1f7',
        card:         '#ffffff',
        border:       '#d8dce8',
        accent:       '#1e3a5f',
        'accent-dim': '#2d5a8e',
        'accent-dark':'#0E1729',
        text:         '#0E1729',
        muted:        '#546178',
        dim:          '#b8c0d0',
        green:        '#0a7a52',
        red:          '#c0392b',
        blue:         '#1d4ed8',
        purple:       '#6d28d9',
        orange:       '#c2440e',
      },
      keyframes: {
        'flow-right': { '0%': { left: '-100%' }, '100%': { left: '200%' } },
        'flow-down':  { '0%': { top: '-40%' },  '100%': { top: '140%' } },
        'bounce-y':   { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(6px)' } },
      },
      animation: {
        'flow-right': 'flow-right 3s linear infinite',
        'flow-down':  'flow-down 2s linear infinite',
        'bounce-slow':'bounce-y 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
