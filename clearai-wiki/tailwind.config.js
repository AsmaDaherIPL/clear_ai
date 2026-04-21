/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Space Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Geist Mono"', 'ui-monospace', 'monospace'],
        ar: ['"Noto Naskh Arabic"', '"Space Grotesk"', 'serif'],
      },
      colors: {
        // ClearAI v5 design tokens — warm paper neutrals + orange accent
        bg:           '#FAFAFA',
        surface:      '#F5F5F4',
        card:         '#FFFFFF',
        border:       '#E8E9EA',
        'border-soft':'#F0F1F2',
        accent:       '#94421C',   // orange-2 (deep)
        'accent-dim': '#EA6A1F',   // orange-1 (bright)
        'accent-dark':'#94421C',
        text:         '#151516',
        'text-2':     '#2B2B2D',
        muted:        '#7C7C7F',
        dim:          '#A6A8AC',
        'dim-2':      '#D4D6D8',
        green:        '#2E7D57',
        'green-wash': '#E6F1EC',
        red:          '#94421C',
        blue:         '#94421C',
        purple:       '#94421C',
        orange:       '#EA6A1F',
        'orange-wash':   '#FDEFE5',
        'orange-wash-2': '#FBE3D1',
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
