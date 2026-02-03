/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // SoundRaft brand color palette
        primary: {
          50: '#f0f7ff',   // alice-blue tint
          100: '#e0efff',
          200: '#b8daff',
          300: '#85c1ff',
          400: '#4da3ff',
          500: '#1f83ff',  // azure-blue (main brand color)
          600: '#1a6fd9',
          700: '#155bb3',
          800: '#124991',  // steel-azure
          900: '#0d3a73',
          950: '#082550',
        },
        surface: {
          50: '#f0f7ff',   // alice-blue
          100: '#e1ecf7',
          200: '#c3d4e8',
          300: '#9eb8d4',
          400: '#7a9bc0',
          500: '#5a7fa8',
          600: '#3d5f85',
          700: '#1e3a5c',
          800: '#0f2540',
          900: '#081526',
          950: '#020913',  // ink-black
        },
        // Accent color for highlights, warnings, notifications
        accent: {
          red: '#ff4242',     // strawberry-red
          redLight: '#ffe8e8', // soft-blush
          amber: '#ff9b1f',   // amber-glow
          amberLight: '#ffac4a', // amber-glow-2
        }
      }
    },
  },
  plugins: [],
}
