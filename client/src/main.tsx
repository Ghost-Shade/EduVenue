import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  // Fail loudly rather than rendering into nothing. A silent no-op here is one
  // of the most time-consuming classes of frontend bug to diagnose.
  throw new Error('Root element #root was not found in index.html')
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
