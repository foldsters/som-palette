import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import App from './App'
import NudipickPage from './NudipickPage'

const isNudipick = new URLSearchParams(window.location.search).has('nudipick')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isNudipick ? <NudipickPage /> : <App />}
  </StrictMode>,
)
