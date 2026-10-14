import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App.jsx';
import { ToastProvider, ConfirmProvider } from './components/ui.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ToastProvider><ConfirmProvider><App /></ConfirmProvider></ToastProvider>
  </React.StrictMode>
);
