/**
 * Tailwind configuration for EduVenue.
 *
 * The palette is deliberately small and semantic. Colours are named for what
 * they MEAN in this application rather than what they look like, so that a
 * booking status is never expressed by a colour chosen at a call site.
 *
 * Every text/background pairing below was chosen to clear WCAG AA contrast
 * (4.5:1 for body text) against its intended surface.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],

  theme: {
    extend: {
      colors: {
        // Primary academic blue. 600 is the default action colour; 700 the
        // hover; 900 for headings on light surfaces.
        brand: {
          50: '#eef4ff',
          100: '#d9e5ff',
          200: '#bcd2ff',
          300: '#8eb4ff',
          400: '#598bff',
          500: '#3366f2',
          600: '#1f47d6',
          700: '#1a37ab',
          800: '#1a3087',
          900: '#1b2d6b',
        },
        // Accent used sparingly for emphasis and the "recommended" marker.
        accent: {
          100: '#fef3c7',
          400: '#fbbf24',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
        },
        // Campus surface neutrals. Slightly cool to sit with the brand blue.
        campus: {
          50: '#f7f8fa',
          100: '#eef0f4',
          200: '#dfe3ea',
          300: '#c3cad6',
          400: '#94a0b3',
          500: '#6b7789',
          600: '#4d5869',
          700: '#3a4354',
          800: '#262d3a',
          900: '#171c26',
        },
      },

      fontFamily: {
        sans: [
          'Inter',
          'Segoe UI',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
      },

      // A restrained shadow scale. Facility cards rely on border + one shadow
      // step rather than heavy elevation.
      boxShadow: {
        card: '0 1px 2px 0 rgb(23 28 38 / 0.04), 0 1px 3px 0 rgb(23 28 38 / 0.06)',
        raised: '0 4px 12px -2px rgb(23 28 38 / 0.10), 0 2px 4px -2px rgb(23 28 38 / 0.06)',
      },

      // Focus ring is defined once here so keyboard focus is consistent and
      // never removed without replacement.
      ringColor: {
        DEFAULT: '#1f47d6',
      },
    },
  },

  plugins: [],
}
