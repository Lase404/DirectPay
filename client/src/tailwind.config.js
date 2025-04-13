/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,jsx,ts,tsx}', // Scan all React files for Tailwind classes
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'], // Use Inter as default font
      },
      colors: {
        primary: 'var(--primary)', // Reference CSS custom properties
        success: 'var(--success)',
        error: 'var(--error)',
        background: 'var(--background)',
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-in', // Match CSS animation in ConnectWalletApp.css
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
