import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';
import { adminGuard } from './core/guards/admin.guard';

export const routes: Routes = [
  { path: '', redirectTo: '/dashboard', pathMatch: 'full' },
  {
    path: 'login',
    loadComponent: () => import('./features/login/login.component').then(m => m.LoginComponent),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./app-shell.component').then(m => m.AppShellComponent),
    children: [
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent),
      },
      {
        path: 'flows',
        loadComponent: () => import('./features/flows/flows.component').then(m => m.FlowsComponent),
      },
      {
        path: 'domains',
        loadComponent: () => import('./features/domains/domains.component').then(m => m.DomainsComponent),
      },
      {
        path: 'mappings',
        loadComponent: () => import('./features/mappings/mappings.component').then(m => m.MappingsComponent),
      },
      {
        path: 'subscribers',
        loadComponent: () => import('./features/subscribers/subscribers.component').then(m => m.SubscribersComponent),
      },
      {
        path: 'ipdr',
        loadComponent: () => import('./features/ipdr/ipdr.component').then(m => m.IpdrComponent),
      },
      {
        path: 'alerts',
        loadComponent: () => import('./features/alerts/alerts.component').then(m => m.AlertsComponent),
      },
      {
        path: 'policy',
        loadComponent: () => import('./features/policy/policy.component').then(m => m.PolicyComponent),
      },
      {
        path: 'app-usage',
        loadComponent: () => import('./features/app-usage/app-usage.component').then(m => m.AppUsageComponent),
      },
      {
        path: 'users',
        canActivate: [adminGuard],
        loadComponent: () => import('./features/users/users.component').then(m => m.UsersComponent),
      },
    ],
  },
  { path: '**', redirectTo: '/dashboard' },
];
