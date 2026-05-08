import { Component, inject, OnInit, OnDestroy, signal } from '@angular/core';
import { NgIf, NgFor, NgClass, DecimalPipe, DatePipe } from '@angular/common';
import { MatTableModule } from '@angular/material/table';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BaseChartDirective } from 'ng2-charts';
import { ChartConfiguration, ChartData } from 'chart.js';
import { Chart, registerables } from 'chart.js';
import { Subscription } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { WebSocketService } from '../../core/services/websocket.service';
import { TimeFilterComponent, TimeFilter } from '../../shared/time-filter/time-filter.component';

Chart.register(...registerables);

function fmtBytes(b: number): string {
  if (typeof b !== 'number') b = Number(b);
  if (!b) return '0 B';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(2) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(2) + ' KB';
  return b + ' B';
}

function fmtApp(app: string, hostnames: string | null | undefined): string {
  if (!app || !app.startsWith('NetBIOS')) return app || 'Unknown';
  if (!hostnames) return app;
  try {
    const arr: string[] = JSON.parse(hostnames);
    if (arr.length > 0 && arr[0]) return `${app} {${arr[0]}}`;
  } catch { /* ignore malformed JSON */ }
  return app;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    NgIf, NgFor, NgClass, DecimalPipe, DatePipe,
    MatTableModule, MatIconModule, MatButtonModule,
    MatSlideToggleModule, MatProgressBarModule, MatTooltipModule,
    BaseChartDirective, TimeFilterComponent,
  ],
  styles: [`
    .dash-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .charts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .two-col-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .chart-wrap { position: relative; height: 260px; width: 100%; }
    .chart-wrap canvas { position: absolute; inset: 0; }
  `],
  template: `
    <div class="dash-header">
      <div class="page-header" style="margin:0;">
        <span class="live-dot"></span>Real-time Dashboard
      </div>
      <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap;">
        <mat-slide-toggle [checked]="!ws.paused()" (change)="ws.toggle()" color="accent" style="font-size:0.85rem;">
          {{ ws.paused() ? 'Paused' : 'Live' }}
        </mat-slide-toggle>
        <mat-slide-toggle [checked]="showUnknown()" (change)="showUnknown.set($event.checked)" color="primary" style="font-size:0.85rem;">
          Show Unclassified
        </mat-slide-toggle>
      </div>
    </div>

    <!-- Time filter (does NOT affect live flows) -->
    <div style="margin-bottom:1rem;">
      <app-time-filter (filterChange)="onFilterChange($event)"></app-time-filter>
    </div>

    <!-- KPI cards -->
    <div class="stat-grid">
      <div class="card" *ngFor="let kpi of kpis()">
        <div class="card-title">{{ kpi.label }}</div>
        <div class="card-value">{{ kpi.value }}</div>
        <div class="card-sub" *ngIf="kpi.sub">{{ kpi.sub }}</div>
      </div>
    </div>

    <!-- Charts row -->
    <div class="charts-grid">
      <div class="chart-card">
        <div class="card-title">Bandwidth Over Time</div>
        <div class="chart-wrap">
          <canvas baseChart [data]="bwChartData" [options]="lineOpts" type="line"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <div class="card-title">Protocol Distribution</div>
        <div class="chart-wrap">
          <canvas baseChart [data]="protoChartData" [options]="doughnutOpts" type="doughnut"></canvas>
        </div>
      </div>
    </div>

    <!-- Top apps + Top talkers -->
    <div class="two-col-grid">
      <div class="card">
        <div class="card-title">Top Applications</div>
        <div *ngFor="let app of filteredTopApps()" style="margin-bottom:0.75rem;">
          <div style="display:flex;justify-content:space-between;font-size:0.85rem;margin-bottom:3px;">
            <span style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%;">
              {{ app.application || 'Unknown' }}
              <span *ngIf="isUnclassified(app)" style="color:#f59e0b;font-size:0.75rem;">(unclassified)</span>
            </span>
            <span style="color:#94a3b8;flex-shrink:0;margin-left:0.5rem;">{{ fmtBytes(app.bytes || app.total_bytes || 0) }}</span>
          </div>
          <mat-progress-bar mode="determinate" [value]="appPct(app)" color="accent" style="border-radius:4px;height:4px;"></mat-progress-bar>
          <div style="font-size:0.75rem;color:#64748b;margin-top:2px;">{{ app.flows | number }} flows</div>
        </div>
        <div *ngIf="!filteredTopApps().length" style="color:#475569;font-size:0.85rem;">No data</div>
      </div>

      <div class="card" style="overflow:auto;">
        <div class="card-title">Top Talkers (Source IPs)</div>
        <table mat-table [dataSource]="topTalkers()" style="width:100%;background:transparent;">
          <ng-container matColumnDef="ip">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">IP / Subscriber</th>
            <td mat-cell *matCellDef="let r" style="font-size:0.82rem;">
              <div style="font-family:monospace;">{{ r.ip }}</div>
              <div *ngIf="r.subscriber_id && r.subscriber_id !== 'unknown'" style="color:#818cf8;font-size:0.75rem;">{{ r.subscriber_id }}</div>
            </td>
          </ng-container>
          <ng-container matColumnDef="bytes">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Bytes</th>
            <td mat-cell *matCellDef="let r">{{ fmtBytes(r.total_bytes || 0) }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="['ip','bytes']"></tr>
          <tr mat-row *matRowDef="let row; columns: ['ip','bytes']"></tr>
        </table>
        <div *ngIf="!topTalkers().length" style="color:#475569;font-size:0.85rem;padding-top:0.5rem;">No data</div>
      </div>
    </div>

    <!-- Live flows — unaffected by time filter, always last 5 min -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;flex-wrap:wrap;gap:0.5rem;">
        <span class="card-title" style="margin:0;">
          Live Flows <span class="live-dot" style="margin-left:8px;"></span>
          <span style="font-size:0.72rem;color:#64748b;font-weight:400;margin-left:8px;">(records of last 5 mins)</span>
        </span>
        <span style="color:#475569;font-size:0.75rem;">
          {{ ws.paused() ? '⏸ Updates paused' : 'Auto-refreshes every 15s' }}
        </span>
      </div>
      <div style="overflow-x:auto;">
        <table mat-table [dataSource]="filteredLiveFlows()" style="width:100%;background:transparent;min-width:700px;">
          <ng-container matColumnDef="src">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Source</th>
            <td mat-cell *matCellDef="let f" style="font-size:0.8rem;">
              <div style="font-family:monospace;">{{ f.src_ip }}:{{ f.src_port }}</div>
              <div style="color:#818cf8;font-size:0.72rem;" *ngIf="f.subscriber_id && f.subscriber_id !== 'unknown'">{{ f.subscriber_id }}</div>
            </td>
          </ng-container>
          <ng-container matColumnDef="dst">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Destination</th>
            <td mat-cell *matCellDef="let f" style="font-family:monospace;font-size:0.8rem;">{{ f.dst_ip }}:{{ f.dst_port }}</td>
          </ng-container>
          <ng-container matColumnDef="proto">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Proto</th>
            <td mat-cell *matCellDef="let f">
              <span class="badge" [ngClass]="protoBadge(f.protocol)">{{ protoName(f.protocol) }}</span>
            </td>
          </ng-container>
          <ng-container matColumnDef="app">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Application</th>
            <td mat-cell *matCellDef="let f" style="font-size:0.85rem;">
              <span [style.color]="f._unclassified ? '#f59e0b' : 'inherit'">{{ fmtApp(f.application, f.hostnames) }}</span>
              <span *ngIf="f.application_category" style="color:#64748b;font-size:0.72rem;margin-left:4px;">({{ f.application_category }})</span>
            </td>
          </ng-container>
          <ng-container matColumnDef="bytes">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Bytes</th>
            <td mat-cell *matCellDef="let f">{{ fmtBytes(f.total_bytes || 0) }}</td>
          </ng-container>
          <ng-container matColumnDef="updated">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Last Seen</th>
            <td mat-cell *matCellDef="let f" style="font-size:0.8rem;color:#94a3b8;">{{ f.updated_at | date:'HH:mm:ss' }}</td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="flowCols"></tr>
          <tr mat-row *matRowDef="let row; columns: flowCols;"></tr>
        </table>
      </div>
      <div *ngIf="!filteredLiveFlows().length" style="color:#475569;font-size:0.85rem;padding:1rem;text-align:center;">
        {{ ws.paused() ? 'Display frozen — click Resume to see new flows' : 'Waiting for live traffic…' }}
      </div>
    </div>
  `,
})
export class DashboardComponent implements OnInit, OnDestroy {
  private api = inject(ApiService);
  ws = inject(WebSocketService);
  private sub?: Subscription;

  kpis       = signal<any[]>([]);
  _topApps   = signal<any[]>([]);
  topTalkers = signal<any[]>([]);
  _liveFlows = signal<any[]>([]);
  flowCols   = ['src', 'dst', 'proto', 'app', 'bytes', 'updated'];
  showUnknown = signal(true);
  activeFilter = signal<TimeFilter>({ start: null, end: null });

  maxAppBytes = 0;
  fmtBytes = fmtBytes;
  fmtApp   = fmtApp;

  filteredTopApps() {
    const apps = this._topApps();
    return this.showUnknown() ? apps : apps.filter(a => !this.isUnclassified(a));
  }

  filteredLiveFlows() {
    const flows = this._liveFlows();
    return this.showUnknown() ? flows : flows.filter(f => !f._unclassified);
  }

  bwChartData: ChartData<'line'> = {
    labels: [],
    datasets: [{
      data: [], label: 'Bytes',
      borderColor: '#6366f1', backgroundColor: 'rgba(99,102,241,0.1)',
      fill: true, tension: 0.4, pointRadius: 2,
    }],
  };

  protoChartData: ChartData<'doughnut'> = {
    labels: ['TCP', 'UDP', 'ICMP', 'Other'],
    datasets: [{ data: [0, 0, 0, 0], backgroundColor: ['#6366f1', '#22d3ee', '#f59e0b', '#64748b'] }],
  };

  lineOpts: ChartConfiguration['options'] = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#64748b', maxTicksLimit: 8 }, grid: { color: '#1e2233' } },
      y: { ticks: { color: '#64748b', callback: v => fmtBytes(+v) }, grid: { color: '#1e2233' } },
    },
  };

  doughnutOpts: ChartConfiguration['options'] = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom', labels: { color: '#94a3b8', boxWidth: 12, padding: 12 } } },
  };

  ngOnInit() {
    // TimeFilterComponent emits the default "Last Week" on init, which triggers
    // onFilterChange → loadAll + loadBandwidth. No separate initial load needed.
    this.sub = this.ws.message$.subscribe(msg => {
      if (msg?.type === 'live_update') this.applyWsUpdate(msg.data);
    });
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }

  onFilterChange(f: TimeFilter) {
    this.activeFilter.set(f);
    this.loadFiltered();
    // Live flows are NOT affected by the time filter
    this.api.getLiveFlows(300).subscribe(d => this._liveFlows.set(d));
  }

  private loadFiltered() {
    const f = this.activeFilter();
    const p: Record<string, any> = {};
    if (f.start) p['start'] = f.start;
    if (f.end)   p['end']   = f.end;

    this.api.getOverview(p).subscribe(d => this.updateKpis(d));
    this.api.getTopApps({ ...p, limit: 8 }).subscribe(d => {
      this._topApps.set(d);
      this.maxAppBytes = Math.max(...d.map((r: any) => r.total_bytes || r.bytes || 0), 1);
    });
    this.api.getTopTalkers({ ...p, limit: 8 }).subscribe(d => this.topTalkers.set(d.sources || []));
    this.api.getProtocolDist(p).subscribe(d => {
      const tcp   = d.find((r: any) => r.protocol === 6)?.bytes  || 0;
      const udp   = d.find((r: any) => r.protocol === 17)?.bytes || 0;
      const icmp  = d.find((r: any) => r.protocol === 1)?.bytes  || 0;
      const other = d.filter((r: any) => ![1,6,17].includes(r.protocol))
                     .reduce((s: number, r: any) => s + (r.bytes || 0), 0);
      this.protoChartData = {
        ...this.protoChartData,
        datasets: [{ ...this.protoChartData.datasets[0], data: [tcp, udp, icmp, other] }],
      };
    });
    // Bandwidth also respects the time filter
    this.api.getBandwidth(p).subscribe(d => {
      this.bwChartData = {
        labels: d.map((r: any) => r.bucket?.slice(11, 16) || r.bucket?.slice(0, 10) || ''),
        datasets: [{ ...this.bwChartData.datasets[0], data: d.map((r: any) => r.bytes || 0) }],
      };
    });
  }

  // WebSocket pushes always reflect "now" — update live widgets only, never the filter-scoped ones
  private applyWsUpdate(data: any) {
    if (data.live_flows) this._liveFlows.set(data.live_flows);
  }

  private updateKpis(d: any) {
    this.kpis.set([
      { label: 'Total Flows',       value: (d.total_flows || 0).toLocaleString() },
      { label: 'Total Bytes',       value: fmtBytes(d.total_bytes || 0) },
      { label: 'Flows (60s)',       value: (d.flows_last_60s || 0).toLocaleString(), sub: 'last minute' },
      { label: 'Bytes (60s)',       value: fmtBytes(d.bytes_last_60s || 0),          sub: 'last minute' },
      { label: 'Unique Source IPs', value: (d.unique_src_ips || 0).toLocaleString() },
      { label: 'Applications',      value: (d.unique_apps || 0).toLocaleString() },
    ]);
  }

  appPct(app: any): number {
    return Math.min(100, ((app.bytes || app.total_bytes || 0) / this.maxAppBytes) * 100);
  }

  isUnclassified(app: any): boolean {
    const RAW = new Set(['TLS','QUIC','HTTP','HTTPS','DNS','NTP','ICMP','DHCP','Unknown','']);
    return !app.application || RAW.has(app.application) || !app.category;
  }

  protoName(p: number) { return ({ 6: 'TCP', 17: 'UDP', 1: 'ICMP' } as any)[p] || `${p}`; }
  protoBadge(p: number) { return ({ 6: 'badge-tcp', 17: 'badge-udp', 1: 'badge-icmp' } as any)[p] || 'badge-other'; }
}
