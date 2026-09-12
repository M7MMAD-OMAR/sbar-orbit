import { createRoot } from 'react-dom/client';
import { createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from '@tanstack/react-router';
import App from './App';
import './styles.css';
const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: () => <main className="not-found"><h1>A little off orbit.</h1><p>This page does not exist.</p><a className="button" href="/">Back to Orbit</a></main> });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: App });
export const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]), defaultPreload: 'intent' });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
await router.load();
// The static document is readable before JavaScript. Mount the router as a
// client application because its provider tree differs from the static render.
createRoot(root).render(<RouterProvider router={router} />);
