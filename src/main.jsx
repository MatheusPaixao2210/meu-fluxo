import React, { Component, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return <main className="error-screen">
        <section><div className="brand-mark">MF</div><p className="eyebrow">ERRO DE CARREGAMENTO</p>
          <h1>Não foi possível abrir o sistema.</h1>
          <p>{this.state.error.message || 'Atualize a página e tente novamente.'}</p>
        </section>
      </main>
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>,
)
