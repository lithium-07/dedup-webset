import '../styles/globals.css'
import { SnackbarProvider } from 'notistack'
import Navbar from '../components/Navbar'

export default function App({ Component, pageProps }) {
  return (
    <SnackbarProvider 
      maxSnack={3}
      anchorOrigin={{
        vertical: 'top',
        horizontal: 'right',
      }}
      dense
      preventDuplicate
    >
      <Navbar />
      <Component {...pageProps} />
    </SnackbarProvider>
  )
} 