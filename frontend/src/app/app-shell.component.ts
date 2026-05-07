import { Component, inject, OnInit } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { AsyncPipe, NgIf, NgFor } from '@angular/common';
import { AuthService } from './core/services/auth.service';
import { WebSocketService } from './core/services/websocket.service';

interface NavItem { label: string; icon: string; path: string; }

@Component({
  selector: 'app-shell',
  standalone: true,
  imports: [
    RouterOutlet, RouterLink, RouterLinkActive,
    MatSidenavModule, MatListModule, MatIconModule,
    MatButtonModule, AsyncPipe, NgIf, NgFor,
  ],
  template: `
    <mat-sidenav-container class="sidenav-layout">
      <mat-sidenav class="sidenav" mode="side" opened>
        <div style="padding:1.5rem 1rem 1rem;">
          <div style="font-size:1.25rem;font-weight:700;color:#818cf8;margin-bottom:0.25rem;">◈ FlowMon</div>
          <div style="font-size:0.75rem;color:#64748b;">ISP Traffic Analytics</div>
        </div>

        <mat-nav-list>
          <a *ngFor="let n of nav" mat-list-item [routerLink]="n.path" routerLinkActive="active-link">
            <mat-icon matListItemIcon>{{ n.icon }}</mat-icon>
            <span matListItemTitle>{{ n.label }}</span>
          </a>
        </mat-nav-list>

        <div style="position:absolute;bottom:1rem;left:1rem;right:1rem;">
          <div style="font-size:0.75rem;color:#475569;margin-bottom:0.5rem;">
            <span class="live-dot"></span>
            <span *ngIf="ws.connected$ | async; else offline">Live</span>
            <ng-template #offline>Reconnecting…</ng-template>
            <span *ngIf="ws.paused()" style="color:#f59e0b;margin-left:6px;">⏸ Paused</span>
          </div>
          <div style="font-size:0.8rem;color:#94a3b8;margin-bottom:0.75rem;">
            {{ auth.currentUser?.username }} ({{ auth.currentUser?.role }})
          </div>
          <button mat-stroked-button color="warn" (click)="auth.logout()" style="width:100%;font-size:0.8rem;">
            Logout
          </button>
        </div>
      </mat-sidenav>

      <mat-sidenav-content class="sidenav-content" style="padding:1.25rem 1.5rem;overflow:auto;">
        <router-outlet />
      </mat-sidenav-content>
    </mat-sidenav-container>
  `,
  styles: [`
    .active-link { background: rgba(99,102,241,0.15) !important; color: #818cf8 !important; border-radius: 8px; }
    .active-link mat-icon { color: #818cf8; }
    mat-nav-list a { border-radius: 8px; margin: 2px 8px; }
  `],
})
export class AppShellComponent implements OnInit {
  auth = inject(AuthService);
  ws   = inject(WebSocketService);

  nav: NavItem[] = [
    { label: 'Dashboard',    icon: 'dashboard',           path: '/dashboard'   },
    { label: 'Flows',        icon: 'swap_horiz',          path: '/flows'       },
    { label: 'Domains',      icon: 'dns',                 path: '/domains'     },
    { label: 'App Mappings', icon: 'category',            path: '/mappings'    },
    { label: 'Subscribers',  icon: 'people',              path: '/subscribers' },
    { label: 'IPDRs',        icon: 'vpn_key',             path: '/ipdr'        },
    { label: 'Alerts',       icon: 'notifications_active', path: '/alerts'     },
    { label: 'Policy',       icon: 'policy',               path: '/policy'      },
  ];

  ngOnInit() { this.ws.connect(); }
}
