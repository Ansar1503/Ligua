import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { SmartToaster, toast } from 'react-smart-toaster';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SmartToaster 
    store={toast} 
    lightBackground={true} 
    position={"bottom_right"}
    autoCloseDelay={3000}
    maxToasts={3}
/>
    <App />
  </React.StrictMode>,
);
