import { Component, inject, OnInit, signal } from '@angular/core';
import { NgIf, NgFor, NgClass, DecimalPipe, DatePipe, SlicePipe } from '@angular/common';
import { FormBuilder, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { MatSortModule } from '@angular/material/sort';
import { MatChipsModule } from '@angular/material/chips';
import { ApiService } from '../../core/services/api.service';

function fmtBytes(b: number): string {
  if (!b) return '0 B';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(2) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(2) + ' KB';
  return b + ' B';
}

@Component({
  selector: 'app-ipdr-flows-modal',
  standalone: true,
  imports: [NgIf, NgFor, DecimalPipe, DatePipe, SlicePipe, MatButtonModule, MatIconModule,
            MatTableModule, MatProgressSpinnerModule, MatDialogModule],
  template: `
    <div style="padding:1.5rem;min-width:700px;max-width:95vw;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <h2 style="margin:0;font-size:1.1rem;color:#818cf8;">
          <mat-icon style="vertical-align:middle;margin-right:6px;">vpn_key</mat-icon>
          IPDR Flows — {{ data.key_string | slice:0:60 }}{{ data.key_string.length > 60 ? '…' : '' }}
        </h2>
        <button mat-icon-button (click)="close()"><mat-icon>close</mat-icon></button>
      </div>
      <div style="font-size:0.82rem;color:#64748b;margin-bottom:1rem;">
        {{ data.src_ip }} → {{ data.dst_ip }}:{{ data.dst_port }} · {{ data.application }}
        <span *ngIf="data.subscriber_id !== 'unknown'" style="color:#818cf8;margin-left:8px;">{{ data.subscriber_id }}</span>
      </div>
      <div *ngIf="loading()" style="text-align:center;padding:2rem;">
        <mat-spinner diameter="36" style="margin:auto;"></mat-spinner>
      </div>
      <div *ngIf="!loading()" style="overflow:auto;max-height:60vh;">
        <table mat-table [dataSource]="flows()" style="width:100%;background:transparent;min-width:600px;">
          <ng-container matColumnDef="start">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Start</th>
            <td mat-cell *matCellDef="let f" style="font-size:0.78rem;color:#94a3b8;">{{ f.start_time | date:'MM/dd HH:mm:ss' }}</td>
          </ng-container>
          <ng-container matColumnDef="src">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Source</th>
            <td mat-cell *matCellDef="let f" style="font-family:monospace;font-size:0.8rem;">{{ f.src_ip }}:{{ f.src_port }}</td>
          </ng-container>
          <ng-container matColumnDef="dst">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Destination</th>
            <td mat-cell *matCellDef="let f" style="font-family:monospace;font-size:0.8rem;">{{ f.dst_ip }}:{{ f.dst_port }}</td>
          </ng-container>
          <ng-container matColumnDef="bytes">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Bytes</th>
            <td mat-cell *matCellDef="let f" style="font-size:0.82rem;">{{ fmt(f.total_bytes) }}</td>
          </ng-container>
          <ng-container matColumnDef="packets">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Packets</th>
            <td mat-cell *matCellDef="let f" style="font-size:0.82rem;">{{ f.total_packets | number }}</td>
          </ng-container>
          <ng-container matColumnDef="dur">
            <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Duration</th>
            <td mat-cell *matCellDef="let f" style="font-size:0.82rem;">
              {{ f.flow_duration_ms ? (f.flow_duration_ms < 1000 ? f.flow_duration_ms.toFixed(0)+'ms' : (f.flow_duration_ms/1000).toFixed(1)+'s') : '—' }}
            </td>
          </ng-container>
          <tr mat-header-row *matHeaderRowDef="cols"></tr>
          <tr mat-row *matRowDef="let row; columns: cols;"></tr>
        </table>
        <p *ngIf="!flows().length" style="text-align:center;color:#475569;padding:1rem;">No flows found for this IPDR key.</p>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:1rem;">
        <button mat-flat-button color="primary" (click)="close()">Close</button>
      </div>
    </div>
  `,
})
export class IpdrFlowsModalComponent implements OnInit {
  private api   = inject(ApiService);
  private dialog = inject(MatDialog);
  data: any;
  flows   = signal<any[]>([]);
  loading = signal(true);
  cols    = ['start', 'src', 'dst', 'bytes', 'packets', 'dur'];
  fmt     = fmtBytes;

  ngOnInit() {
    this.api.getIpdrFlows(this.data.id).subscribe({
      next: (r: any) => { this.flows.set(r.rows); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }
  close() { this.dialog.closeAll(); }
}

@Component({
  selector: 'app-ipdr',
  standalone: true,
  imports: [
    NgIf, NgFor, NgClass, DecimalPipe, DatePipe,
    ReactiveFormsModule, FormsModule,
    MatTableModule, MatPaginatorModule, MatFormFieldModule,
    MatInputModule, MatSelectModule, MatButtonModule,
    MatIconModule, MatProgressSpinnerModule, MatTooltipModule,
    MatDialogModule, MatSortModule, MatChipsModule,
  ],
  template: `
    <div class="page-header">IPDRs — IP Data Records</div>

    <!-- Filters -->
    <div class="card" style="margin-bottom:1rem;display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;">
      <mat-form-field appearance="outline" style="width:200px;">
        <mat-label>Source IP</mat-label>
        <input matInput [(ngModel)]="f_src">
      </mat-form-field>
      <mat-form-field appearance="outline" style="width:200px;">
        <mat-label>Dest IP</mat-label>
        <input matInput [(ngModel)]="f_dst">
      </mat-form-field>
      <mat-form-field appearance="outline" style="width:180px;">
        <mat-label>Application</mat-label>
        <input matInput [(ngModel)]="f_app">
      </mat-form-field>
      <mat-form-field appearance="outline" style="width:160px;">
        <mat-label>Subscriber ID</mat-label>
        <input matInput [(ngModel)]="f_sub">
      </mat-form-field>
      <mat-form-field appearance="outline" style="width:130px;">
        <mat-label>Status</mat-label>
        <mat-select [(ngModel)]="f_status">
          <mat-option value="">All</mat-option>
          <mat-option value="active">Active</mat-option>
          <mat-option value="closed">Closed</mat-option>
        </mat-select>
      </mat-form-field>
      <button mat-flat-button color="primary" (click)="search()"><mat-icon>search</mat-icon></button>
      <button mat-stroked-button (click)="reset()"><mat-icon>clear</mat-icon></button>
      <span style="margin-left:auto;color:#64748b;font-size:0.85rem;">{{ total() | number }} records</span>
    </div>

    <!-- Sort chips -->
    <div style="margin-bottom:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
      <span style="font-size:0.8rem;color:#64748b;">Sort by:</span>
      <button *ngFor="let s of sortOptions" mat-stroked-button
              [ngClass]="currentSort===s.key ? 'active-preset' : ''"
              style="height:28px;line-height:28px;font-size:0.78rem;padding:0 10px;"
              (click)="sortBy(s.key)">
        {{ s.label }}
        <mat-icon *ngIf="currentSort===s.key" style="font-size:14px;height:14px;width:14px;margin-left:2px;">
          {{ sortOrder==='desc' ? 'arrow_downward' : 'arrow_upward' }}
        </mat-icon>
      </button>
    </div>

    <!-- Table -->
    <div class="card" style="overflow:auto;">
      <div *ngIf="loading()" style="text-align:center;padding:2rem;">
        <mat-spinner diameter="40" style="margin:auto;"></mat-spinner>
      </div>
      <table *ngIf="!loading()" mat-table [dataSource]="rows()"
             style="width:100%;background:transparent;min-width:1200px;"
             class="clickable-rows">
        <ng-container matColumnDef="key_string">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Key / Session</th>
          <td mat-cell *matCellDef="let r" style="font-family:monospace;font-size:0.72rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
              [matTooltip]="r.key_string">{{ r.key_string }}</td>
        </ng-container>
        <ng-container matColumnDef="src_ip">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Source IP</th>
          <td mat-cell *matCellDef="let r" style="font-family:monospace;font-size:0.82rem;">
            {{ r.src_ip }}
            <div *ngIf="r.subscriber_id !== 'unknown'" style="color:#818cf8;font-size:0.72rem;">{{ r.subscriber_id }}</div>
          </td>
        </ng-container>
        <ng-container matColumnDef="dst">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Destination</th>
          <td mat-cell *matCellDef="let r" style="font-family:monospace;font-size:0.82rem;">{{ r.dst_ip }}:{{ r.dst_port }}</td>
        </ng-container>
        <ng-container matColumnDef="application">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Application</th>
          <td mat-cell *matCellDef="let r" style="font-size:0.85rem;">
            {{ r.application || '—' }}
            <span *ngIf="r.application_category" style="color:#64748b;font-size:0.75rem;"> ({{ r.application_category }})</span>
          </td>
        </ng-container>
        <ng-container matColumnDef="packets_sent">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Pkts Sent</th>
          <td mat-cell *matCellDef="let r" style="font-size:0.82rem;">{{ r.packets_sent | number }}</td>
        </ng-container>
        <ng-container matColumnDef="bytes_sent">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Bytes Sent</th>
          <td mat-cell *matCellDef="let r" style="font-size:0.82rem;">{{ fmt(r.bytes_sent) }}</td>
        </ng-container>
        <ng-container matColumnDef="packets_recv">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Pkts Recv</th>
          <td mat-cell *matCellDef="let r" style="font-size:0.82rem;">{{ r.packets_recv | number }}</td>
        </ng-container>
        <ng-container matColumnDef="bytes_recv">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Bytes Recv</th>
          <td mat-cell *matCellDef="let r" style="font-size:0.82rem;">{{ fmt(r.bytes_recv) }}</td>
        </ng-container>
        <ng-container matColumnDef="first_seen">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">First Seen</th>
          <td mat-cell *matCellDef="let r" style="font-size:0.78rem;color:#94a3b8;">{{ r.first_seen | date:'MM/dd HH:mm:ss' }}</td>
        </ng-container>
        <ng-container matColumnDef="last_seen">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Last Seen</th>
          <td mat-cell *matCellDef="let r" style="font-size:0.78rem;color:#94a3b8;">{{ r.last_seen | date:'MM/dd HH:mm:ss' }}</td>
        </ng-container>
        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Status</th>
          <td mat-cell *matCellDef="let r">
            <span class="badge" [ngClass]="r.status==='active' ? 'badge-tcp' : 'badge-other'" style="font-size:0.72rem;">
              {{ r.status }}
            </span>
          </td>
        </ng-container>
        <tr mat-header-row *matHeaderRowDef="cols"></tr>
        <tr mat-row *matRowDef="let row; columns: cols;" style="cursor:pointer;"
            (click)="openFlows(row)"></tr>
      </table>
      <mat-paginator [length]="total()" [pageSize]="pageSize" [pageSizeOptions]="[50,100,200]"
        (page)="onPage($event)" style="background:transparent;color:#94a3b8;"></mat-paginator>
    </div>
  `,
  styles: [`
    .active-preset { background:rgba(99,102,241,0.2)!important;color:#818cf8!important;border-color:#6366f1!important; }
    .clickable-rows tr:hover { background:rgba(99,102,241,0.05); }
  `],
})
export class IpdrComponent implements OnInit {
  private api    = inject(ApiService);
  private dialog = inject(MatDialog);

  cols = ['key_string','src_ip','dst','application','packets_sent','bytes_sent',
          'packets_recv','bytes_recv','first_seen','last_seen','status'];
  rows     = signal<any[]>([]);
  total    = signal(0);
  loading  = signal(false);
  pageSize = 100;
  offset   = 0;
  fmt      = fmtBytes;

  f_src = ''; f_dst = ''; f_app = ''; f_sub = ''; f_status = '';
  currentSort = 'last_seen';
  sortOrder: 'asc' | 'desc' = 'desc';

  sortOptions = [
    { key: 'last_seen',    label: 'Last Seen'   },
    { key: 'bytes_sent',   label: 'Bytes Sent'  },
    { key: 'bytes_recv',   label: 'Bytes Recv'  },
    { key: 'packets_sent', label: 'Pkts Sent'   },
    { key: 'first_seen',   label: 'First Seen'  },
    { key: 'src_ip',       label: 'Source IP'   },
    { key: 'application',  label: 'Application' },
  ];

  ngOnInit() { this.load(); }

  search() { this.offset = 0; this.load(); }
  reset() { this.f_src = this.f_dst = this.f_app = this.f_sub = this.f_status = ''; this.offset = 0; this.load(); }
  onPage(e: PageEvent) { this.pageSize = e.pageSize; this.offset = e.pageIndex * e.pageSize; this.load(); }

  sortBy(key: string) {
    if (this.currentSort === key) {
      this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc';
    } else {
      this.currentSort = key;
      this.sortOrder = 'desc';
    }
    this.offset = 0;
    this.load();
  }

  private load() {
    this.loading.set(true);
    const p: Record<string, any> = {
      limit: this.pageSize, offset: this.offset,
      sort: this.currentSort, order: this.sortOrder,
    };
    if (this.f_src)    p['src_ip']      = this.f_src;
    if (this.f_dst)    p['dst_ip']      = this.f_dst;
    if (this.f_app)    p['application'] = this.f_app;
    if (this.f_sub)    p['subscriber']  = this.f_sub;
    if (this.f_status) p['status']      = this.f_status;
    this.api.getIpdrKeys(p).subscribe({
      next: (r: any) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  openFlows(row: any) {
    const ref = this.dialog.open(IpdrFlowsModalComponent, {
      width: '90vw',
      maxWidth: '900px',
      maxHeight: '90vh',
      panelClass: 'dark-dialog',
    });
    ref.componentInstance.data = row;
  }
}
