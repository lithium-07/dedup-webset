import Link from 'next/link';
import { useRouter } from 'next/router';
import styles from './Navbar.module.css';

export default function Navbar() {
  const router = useRouter();
  
  const isActive = (path) => {
    if (path === '/' && router.pathname === '/') {
      return true;
    }
    if (path !== '/' && router.pathname.startsWith(path)) {
      return true;
    }
    return false;
  };

  return (
    <nav className={styles.navbar}>
      <div className={styles.container}>
        <div className={styles.brand}>
          <Link href="/" className={styles.brandLink}>
            Erased
          </Link>
        </div>
        
        <div className={styles.navLinks}>
          <Link 
            href="/" 
            className={`${styles.navLink} ${isActive('/') ? styles.active : ''}`}
          >
            Query
          </Link>
          <Link 
            href="/history" 
            className={`${styles.navLink} ${isActive('/history') ? styles.active : ''}`}
          >
            History
          </Link>
        </div>
      </div>
    </nav>
  );
} 