import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { NgIf, NgFor, NgClass, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';
import { TimeFilterComponent, TimeFilter } from '../../shared/time-filter/time-filter.component';

function fmtBytes(b: number): string {
  if (!b) return '0 B';
  b = Number(b);
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(2) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(2) + ' KB';
  return b + ' B';
}

@Component({
  selector: 'app-app-usage',
  standalone: true,
  imports: [
    NgIf, NgFor, NgClass, DecimalPipe, FormsModule,
    MatTableModule, MatIconModule, MatButtonModule,
    MatFormFieldModule, MatInputModule, MatProgressBarModule,
    MatProgressSpinnerModule, MatTooltipModule,
    TimeFilterComponent,
  ],
  template: `
    <div class="page-header">Application Usage by IP</div>
    <p style="color:#64748b;font-size:0.85rem;margin-bottom:1rem;">
      Shows total traffic consumed per application per source IP — identify which users use the most bandwidth.
    </p>

    <!-- Time filter -->
    <div style="margin-bottom:1rem;">
      <app-time-filter (filterChange)="onFilterChange($event)"></app-time-filter>
    </div>

    <!-- Search + view toggle -->
    <div class="card" style="margin-bottom:1rem;display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;">
      <input [(ngModel)]="searchIp" (ngModelChange)="applyFilter()"
             placeholder="Filter by IP or subscriber…"
             style="background:#1a1d27;border:1px solid #3d4460;border-radius:6px;color:#e2e8f0;padding:5px 12px;font-size:0.85rem;width:220px;outline:none;">
      <input [(ngModel)]="searchApp" (ngModelChange)="applyFilter()"
             placeholder="Filter by application…"
             style="background:#1a1d27;border:1px solid #3d4460;border-radius:6px;color:#e2e8f0;padding:5px 12px;font-size:0.85rem;width:200px;outline:none;">
      <button mat-stroked-button (click)="searchIp='';searchApp='';applyFilter()" style="height:32px;font-size:0.8rem;">
        <mat-icon style="font-size:16px;width:16px;height:16px;">clear</mat-icon> Clear
      </button>
      <span style="margin-left:auto;font-size:0.82rem;color:#64748b;">
        {{ filtered().length | number }} rows
      </span>
    </div>

    <!-- Loading -->
    <div *ngIf="loading()" style="text-align:center;padding:3rem;">
      <mat-spinner diameter="40" style="margin:auto;"></mat-spinner>
    </div>

    <!-- Grouped by IP view -->
    <ng-container *ngIf="!loading()">
      <div *ngFor="let group of groupedByIp()" class="card" style="margin-bottom:1rem;">
        <!-- IP / subscriber header -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem;">
          <div>
            <span style="font-family:monospace;font-weight:600;font-size:0.95rem;color:#e2e8f0;">{{ group.ip }}</span>
            <span *ngIf="group.subscriber_id && group.subscriber_id !== 'unknown'"
                  style="margin-left:8px;color:#818cf8;font-size:0.82rem;">{{ group.subscriber_id }}{{ group.subscriber_name ? ' — ' + group.subscriber_name : '' }}</span>
          </div>
          <div style="font-size:0.82rem;color:#94a3b8;">
            Total: <strong style="color:#e2e8f0;">{{ fmtBytes(group.total_bytes) }}</strong>
            &nbsp;·&nbsp;
            <span style="color:#64748b;">{{ group.flows | number }} flows</span>
          </div>
        </div>

        <!-- App rows for this IP -->
        <div *ngFor="let row of group.apps; let i = index" style="margin-bottom:0.6rem;">
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.83rem;margin-bottom:3px;">
            <div style="display:flex;align-items:center;gap:0.5rem;min-width:0;">
              <span style="font-weight:500;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px;"
                    [matTooltip]="row.application">{{ row.application || 'Unknown' }}</span>
              <span *ngIf="row.category" class="badge badge-tcp" style="font-size:0.68rem;padding:1px 6px;">{{ row.category }}</span>
            </div>
            <div style="display:flex;gap:1rem;flex-shrink:0;align-items:center;">
              <span style="color:#94a3b8;">{{ row.flows | number }} flows</span>
              <span style="color:#e2e8f0;font-weight:500;min-width:80px;text-align:right;">{{ fmtBytes(row.total_bytes) }}</span>
              <span style="color:#64748b;font-size:0.75rem;min-width:45px;text-align:right;">{{ pct(row.total_bytes, group.total_bytes) }}%</span>
            </div>
          </div>
          <mat-progress-bar mode="determinate"
                            [value]="pct(row.total_bytes, group.total_bytes)"
                            [color]="i === 0 ? 'accent' : 'primary'"
                            style="border-radius:4px;height:3px;"></mat-progress-bar>
        </div>
      </div>

      <div *ngIf="!groupedByIp().length" style="text-align:center;color:#475569;padding:3rem;font-size:0.9rem;">
        No data for the selected time range.
      </div>
    </ng-container>
  `,
})
export class AppUsageComponent implements OnInit {
  private api = inject(ApiService);

  loading = signal(false);
  private rawRows = signal<any[]>([]);
  searchIp  = '';
  searchApp = '';
  activeFilter = signal<TimeFilter>({ start: null, end: null });
  fmtBytes = fmtBytes;

  filtered = computed(() => {
    let rows = this.rawRows();
    const ip  = this.searchIp.trim().toLowerCase();
    const app = this.searchApp.trim().toLowerCase();
    if (ip)  rows = rows.filter(r => r.src_ip?.toLowerCase().includes(ip) || r.subscriber_id?.toLowerCase().includes(ip) || r.subscriber_name?.toLowerCase().includes(ip));
    if (app) rows = rows.filter(r => r.application?.toLowerCase().includes(app));
    return rows;
  });

  groupedByIp = computed(() => {
    const map = new Map<string, { ip: string; subscriber_id: string; subscriber_name: string; total_bytes: number; flows: number; apps: any[] }>();
    for (const r of this.filtered()) {
      const key = r.src_ip;
      if (!map.has(key)) {
        map.set(key, { ip: r.src_ip, subscriber_id: r.subscriber_id, subscriber_name: r.subscriber_name, total_bytes: 0, flows: 0, apps: [] });
      }
      const g = map.get(key)!;
      g.total_bytes += Number(r.total_bytes) || 0;
      g.flows       += Number(r.flows)       || 0;
      g.apps.push(r);
    }
    // Sort groups by total bytes desc, apps within each group also desc
    return [...map.values()]
      .sort((a, b) => b.total_bytes - a.total_bytes)
      .map(g => ({ ...g, apps: g.apps.sort((a, b) => (Number(b.total_bytes) || 0) - (Number(a.total_bytes) || 0)) }));
  });

  ngOnInit() {
    // TimeFilterComponent auto-emits default preset on init → triggers load
  }

  onFilterChange(f: TimeFilter) {
    this.activeFilter.set(f);
    this.load();
  }

  applyFilter() { /* computed() reacts automatically */ }

  private load() {
    const f = this.activeFilter();
    const p: Record<string, any> = { limit: 1000 };
    if (f.start) p['start'] = f.start;
    if (f.end)   p['end']   = f.end;
    this.loading.set(true);
    this.api.getAppUsage(p).subscribe({
      next: rows => { this.rawRows.set(rows); this.loading.set(false); },
      error: ()  => this.loading.set(false),
    });
  }

  pct(part: number, total: number): number {
    if (!total) return 0;
    return Math.round((Number(part) / Number(total)) * 100);
  }
}
