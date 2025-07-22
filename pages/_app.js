import '../styles/globals.css'
import { SnackbarProvider } from 'notistack'

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
      <Component {...pageProps} />
    </SnackbarProvider>
  )
} 