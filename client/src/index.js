import React from 'react';
import ReactDOM from 'react-dom';
import { BrowserRouter } from 'react-router-dom';
import ConnectWalletApp from './ConnectWallet';

ReactDOM.render(
  <BrowserRouter>
    <ConnectWalletApp />
  </BrowserRouter>,
  document.getElementById('root')
);
