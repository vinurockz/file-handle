import type { Routes } from '@angular/router';
import { inWorkspace, signedIn, signedOut } from './core/auth';
import { MODULES } from './modules';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Sign in · Studio',
    canActivate: [signedOut],
    loadComponent: () => import('./features/auth/login').then((m) => m.Login),
  },
  {
    path: 'workspaces',
    title: 'Workspaces · Studio',
    canActivate: [signedIn],
    loadComponent: () => import('./features/auth/workspaces').then((m) => m.Workspaces),
  },
  {
    path: '',
    canActivate: [inWorkspace],
    loadComponent: () => import('./shell/shell').then((m) => m.Shell),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'files' },
      ...MODULES.map((module) => ({
        path: module.path,
        title: `${module.label} · Studio`,
        loadComponent: module.load,
      })),
    ],
  },
  { path: '**', redirectTo: '' },
];
