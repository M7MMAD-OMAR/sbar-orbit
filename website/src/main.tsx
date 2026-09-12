import { createRoot } from 'react-dom/client';
import { createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from '@tanstack/react-router';
import App from './App';
import '@fontsource-variable/noto-sans-arabic/wght.css';
import './styles.css';
const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: () => <main className="not-found"><h1>{document.documentElement.lang === 'ar' ? 'الصفحة غير موجودة' : 'A little off orbit.'}</h1><p>{document.documentElement.lang === 'ar' ? 'يمكنك الرجوع إلى الصفحة الرئيسية.' : 'This page does not exist.'}</p><a className="button" href={document.documentElement.lang === 'ar' ? '/ar/' : '/'}>{document.documentElement.lang === 'ar' ? 'ارجع إلى أوربت' : 'Back to Orbit'}</a></main> });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <App locale="en" /> });
const arabicRoute = createRoute({ getParentRoute: () => rootRoute, path: '/ar/', component: () => <App locale="ar" /> });
export const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, arabicRoute]), defaultPreload: 'intent' });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
document.documentElement.lang = location.pathname.startsWith('/ar') ? 'ar' : 'en';
document.documentElement.dir = document.documentElement.lang === 'ar' ? 'rtl' : 'ltr';
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
await router.load();
// The static document is readable before JavaScript. Mount the router as a
// client application because its provider tree differs from the static render.
createRoot(root).render(<RouterProvider router={router} />);
