import { Component, inject, OnInit, signal } from '@angular/core';
import { NgIf, NgFor, NgClass, DecimalPipe, DatePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { ApiService } from '../../core/services/api.service';
import { TimeFilterComponent, TimeFilter } from '../../shared/time-filter/time-filter.component';

function fmtApp(app: string, hostnames: string | null | undefined): string {
  if (!app || !app.startsWith('NetBIOS')) return app || 'Unknown';
  if (!hostnames) return app;
  try {
    const arr: string[] = JSON.parse(hostnames);
    if (arr.length > 0 && arr[0]) return `${app} {${arr[0]}}`;
  } catch { /* ignore malformed JSON */ }
  return app;
}

function fmtBytes(b: number): string {
  if (!b) return '0 B';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(2) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(2) + ' KB';
  return b + ' B';
}

@Component({
  selector: 'app-flow-detail-modal',
  standalone: true,
  imports: [NgIf, NgFor, MatButtonModule, MatIconModule, MatDialogModule, DatePipe],
  template: `
    <div style="padding:1.5rem;max-width:95vw;min-width:340px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <h2 style="margin:0;font-size:1rem;color:#818cf8;">Flow #{{ data?.id }}</h2>
        <button mat-icon-button (click)="close()"><mat-icon>close</mat-icon></button>
      </div>

      <!-- QUIC metadata card -->
      <div *ngIf="quicMeta" style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:0.75rem 1rem;margin-bottom:1rem;">
        <div style="font-size:0.75rem;font-weight:600;color:#22d3ee;letter-spacing:0.05em;margin-bottom:0.5rem;">
          QUIC / TLS Metadata
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.25rem 1rem;font-size:0.8rem;">
          <ng-container *ngFor="let kv of quicRows">
            <span style="color:#64748b;">{{ kv[0] }}</span>
            <span style="color:#e2e8f0;word-break:break-all;">{{ kv[1] }}</span>
          </ng-container>
        </div>
      </div>

      <pre style="font-family:monospace;background:#12151e;color:#e2e8f0;padding:1rem;border-radius:8px;overflow:auto;max-height:55vh;font-size:0.78rem;white-space:pre-wrap;word-break:break-all;">{{ json }}</pre>
      <div style="display:flex;justify-content:flex-end;margin-top:1rem;">
        <button mat-flat-button color="primary" (click)="close()">Close</button>
      </div>
    </div>
  `,
})
export class FlowDetailModalComponent {
  data: any;
  private dialog = inject(MatDialog);

  get quicMeta(): Record<string, any> | null {
    if (!this.data?.metadata) return null;
    try {
      const m = typeof this.data.metadata === 'string'
        ? JSON.parse(this.data.metadata) : this.data.metadata;
      const keys = ['quic_version','tls_version','tls_alpn','ja3_client','ja3_server',
                    'tls_issuer_dn','tls_subject_dn','tls_cert_not_after'];
      const out: Record<string, any> = {};
      for (const k of keys) if (m[k]) out[k] = m[k];
      return Object.keys(out).length ? out : null;
    } catch { return null; }
  }

  get quicRows(): [string, string][] {
    const m = this.quicMeta;
    if (!m) return [];
    const labels: Record<string, string> = {
      quic_version: 'QUIC Version', tls_version: 'TLS Version',
      tls_alpn: 'ALPN', ja3_client: 'JA4 Client', ja3_server: 'JA3 Server',
      tls_issuer_dn: 'Issuer DN', tls_subject_dn: 'Subject DN',
      tls_cert_not_after: 'Cert Expiry',
    };
    return Object.entries(m).map(([k, v]) => [labels[k] || k, String(v)]);
  }

  get json() {
    if (!this.data) return '';
    const d = { ...this.data };
    if (d.metadata && typeof d.metadata === 'string') {
      try { d.metadata = JSON.parse(d.metadata); } catch { /* leave as string */ }
    }
    return JSON.stringify(d, null, 2);
  }

  close() { this.dialog.closeAll(); }
}

@Component({
  selector: 'app-flows',
  standalone: true,
  imports: [
    NgIf, NgFor, NgClass, DecimalPipe, DatePipe,
    ReactiveFormsModule,
    MatTableModule, MatPaginatorModule, MatFormFieldModule,
    MatInputModule, MatSelectModule, MatButtonModule,
    MatIconModule, MatProgressSpinnerModule, MatTooltipModule,
    MatSlideToggleModule, MatDialogModule, TimeFilterComponent,
    FlowDetailModalComponent,
  ],
  template: `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem;">
      <div class="page-header" style="margin:0;">Flow Explorer</div>
      <mat-slide-toggle [checked]="showUnknown()" (change)="showUnknown.set($event.checked)" color="warn">
        Show Unclassified
      </mat-slide-toggle>
    </div>

    <!-- Time Filter -->
    <div style="margin-bottom:1rem;">
      <app-time-filter (filterChange)="onFilterChange($event)"></app-time-filter>
    </div>

    <!-- Filters -->
    <div class="card" style="margin-bottom:1rem;" [formGroup]="filters">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:0.75rem;">
        <mat-form-field appearance="outline">
          <mat-label>Source IP</mat-label>
          <input matInput formControlName="src_ip">
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Dest IP</mat-label>
          <input matInput formControlName="dst_ip">
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Application</mat-label>
          <input matInput formControlName="application">
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Subscriber ID</mat-label>
          <input matInput formControlName="subscriber">
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Protocol</mat-label>
          <mat-select formControlName="protocol">
            <mat-option value="">All</mat-option>
            <mat-option value="6">TCP (6)</mat-option>
            <mat-option value="17">UDP (17)</mat-option>
            <mat-option value="1">ICMP (1)</mat-option>
          </mat-select>
        </mat-form-field>
      </div>
      <div style="display:flex;gap:0.75rem;margin-top:0.5rem;flex-wrap:wrap;align-items:center;">
        <button mat-flat-button color="primary" (click)="search()">
          <mat-icon>search</mat-icon> Search
        </button>
        <button mat-stroked-button (click)="reset()">
          <mat-icon>clear</mat-icon> Reset
        </button>
        <span style="margin-left:auto;color:#64748b;font-size:0.85rem;">
          {{ total() | number }} flows found
        </span>
      </div>
    </div>

    <!-- Table -->
    <div class="card" style="overflow:auto;">
      <div *ngIf="loading()" style="text-align:center;padding:2rem;">
        <mat-spinner diameter="40" style="margin:auto;"></mat-spinner>
      </div>

      <table *ngIf="!loading()" mat-table [dataSource]="rows()" style="width:100%;background:transparent;min-width:1000px;">
        <ng-container matColumnDef="src">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Source</th>
          <td mat-cell *matCellDef="let f" style="font-size:0.8rem;">
            <div style="font-family:monospace;">{{ f.src_ip }}:{{ f.src_port }}</div>
            <div *ngIf="f.subscriber_id && f.subscriber_id !== 'unknown'" style="color:#818cf8;font-size:0.72rem;">{{ f.subscriber_id }}</div>
          </td>
        </ng-container>
        <ng-container matColumnDef="subscriber">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Subscriber</th>
          <td mat-cell *matCellDef="let f" style="font-size:0.85rem;">
            <span *ngIf="f.subscriber_id !== 'unknown'" style="color:#818cf8;font-weight:500;">{{ f.subscriber_id }}</span>
            <span *ngIf="f.subscriber_id === 'unknown'" style="color:#475569;font-style:italic;">unknown</span>
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
          <td mat-cell *matCellDef="let f" style="font-size:0.85rem;" [matTooltip]="fmtApp(f.application, f.hostnames)">
            <span [style.color]="f._unclassified ? '#f59e0b' : 'inherit'">{{ fmtApp(f.application, f.hostnames) }}</span>
            <span *ngIf="f._unclassified" class="badge badge-warn" style="margin-left:4px;font-size:0.7rem;">raw</span>
            <span *ngIf="isQuic(f)" class="badge" style="margin-left:4px;font-size:0.68rem;background:rgba(34,211,238,0.15);color:#22d3ee;border:1px solid rgba(34,211,238,0.3);">QUIC</span>
          </td>
        </ng-container>
        <ng-container matColumnDef="bytes">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Total Bytes</th>
          <td mat-cell *matCellDef="let f">{{ fmtB(f.total_bytes) }}</td>
        </ng-container>
        <ng-container matColumnDef="duration">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Duration</th>
          <td mat-cell *matCellDef="let f">{{ fmtDur(f.flow_duration_ms) }}</td>
        </ng-container>
        <ng-container matColumnDef="start">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Start</th>
          <td mat-cell *matCellDef="let f" style="font-size:0.8rem;color:#94a3b8;">{{ f.start_time | date:'MM/dd HH:mm:ss' }}</td>
        </ng-container>
        <tr mat-header-row *matHeaderRowDef="cols"></tr>
        <tr mat-row *matRowDef="let row; columns: cols;" style="cursor:pointer;"
            (click)="openDetail(row)"
            [style.opacity]="!showUnknown() && row._unclassified ? '0.4' : '1'">
        </tr>
      </table>

      <mat-paginator [length]="total()" [pageSize]="pageSize" [pageSizeOptions]="[25, 50, 100]"
        (page)="onPage($event)" style="background:transparent;color:#94a3b8;"></mat-paginator>
    </div>
  `,
})
export class FlowsComponent implements OnInit {
  private api    = inject(ApiService);
  private fb     = inject(FormBuilder);
  private dialog = inject(MatDialog);

  cols     = ['src', 'subscriber', 'dst', 'proto', 'app', 'bytes', 'duration', 'start'];
  rows     = signal<any[]>([]);
  total    = signal(0);
  loading  = signal(false);
  pageSize = 50;
  offset   = 0;
  showUnknown = signal(true);
  activeFilter = signal<TimeFilter>({ start: null, end: null });
  fmtB   = fmtBytes;
  fmtApp = fmtApp;

  filters = this.fb.group({
    src_ip: [''], dst_ip: [''], application: [''],
    subscriber: [''], protocol: [''],
  });

  ngOnInit() { this.load(); }

  onFilterChange(f: TimeFilter) { this.activeFilter.set(f); this.offset = 0; this.load(); }
  search() { this.offset = 0; this.load(); }

  reset() {
    this.filters.reset({ src_ip:'', dst_ip:'', application:'', subscriber:'', protocol:'' });
    this.offset = 0;
    this.load();
  }

  onPage(e: PageEvent) {
    this.pageSize = e.pageSize;
    this.offset   = e.pageIndex * e.pageSize;
    this.load();
  }

  openDetail(flow: any) {
    const ref = this.dialog.open(FlowDetailModalComponent, {
      width: '90vw', maxWidth: '700px', maxHeight: '90vh', panelClass: 'dark-dialog',
    });
    ref.componentInstance.data = flow;
  }

  private load() {
    this.loading.set(true);
    const f = this.filters.getRawValue();
    const tf = this.activeFilter();
    const params: Record<string, any> = { limit: this.pageSize, offset: this.offset, sort: 'start_time', order: 'desc' };
    if (f.src_ip)      params['src_ip']      = f.src_ip;
    if (f.dst_ip)      params['dst_ip']      = f.dst_ip;
    if (f.application) params['application'] = f.application;
    if (f.subscriber)  params['subscriber']  = f.subscriber;
    if (f.protocol)    params['protocol']    = f.protocol;
    if (tf.start)      params['start']       = tf.start;
    if (tf.end)        params['end']         = tf.end;

    this.api.getFlows(params).subscribe({
      next: (res: any) => { this.rows.set(res.rows); this.total.set(res.total); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  protoName(p: number) { return ({ 6: 'TCP', 17: 'UDP', 1: 'ICMP' } as any)[p] || `${p}`; }
  protoBadge(p: number) { return ({ 6: 'badge-tcp', 17: 'badge-udp', 1: 'badge-icmp' } as any)[p] || 'badge-other'; }
  fmtDur(ms: number) { if (!ms) return '—'; return ms < 1000 ? ms.toFixed(0) + 'ms' : (ms / 1000).toFixed(1) + 's'; }
  isQuic(f: any): boolean {
    const app = (f.application || '').toLowerCase();
    return app === 'quic' || app.includes('quic') ||
           (f.protocol === 17 && f.dst_port === 443);
  }
}
