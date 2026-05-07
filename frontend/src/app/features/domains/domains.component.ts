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
import { MatDialogModule, MatDialog } from '@angular/material/dialog';
import { BaseChartDirective } from 'ng2-charts';
import { ChartData, ChartConfiguration } from 'chart.js';
import { Chart, registerables } from 'chart.js';
import { ApiService } from '../../core/services/api.service';
import { TimeFilterComponent, TimeFilter } from '../../shared/time-filter/time-filter.component';

Chart.register(...registerables);

@Component({
  selector: 'app-flow-detail-modal',
  standalone: true,
  imports: [NgIf, MatButtonModule, MatIconModule, MatDialogModule, DatePipe],
  template: `
    <div style="padding:1.5rem;max-width:95vw;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <h2 style="margin:0;font-size:1rem;color:#818cf8;">Flow #{{ data?.id }}</h2>
        <button mat-icon-button (click)="close()"><mat-icon>close</mat-icon></button>
      </div>
      <pre style="font-family:monospace;background:#12151e;color:#e2e8f0;padding:1rem;border-radius:8px;overflow:auto;max-height:70vh;font-size:0.8rem;white-space:pre-wrap;word-break:break-all;">{{ json }}</pre>
      <div style="display:flex;justify-content:flex-end;margin-top:1rem;">
        <button mat-flat-button color="primary" (click)="close()">Close</button>
      </div>
    </div>
  `,
})
export class FlowDetailModalComponent {
  data: any;
  get json() { return JSON.stringify(this.data, null, 2); }
  private dialog = inject(MatDialog);
  close() { this.dialog.closeAll(); }
}

@Component({
  selector: 'app-domains',
  standalone: true,
  imports: [
    NgIf, NgFor, NgClass, DecimalPipe, DatePipe,
    ReactiveFormsModule,
    MatTableModule, MatPaginatorModule, MatFormFieldModule,
    MatInputModule, MatSelectModule, MatButtonModule,
    MatIconModule, MatProgressSpinnerModule, MatTooltipModule,
    MatDialogModule, BaseChartDirective, TimeFilterComponent,
    FlowDetailModalComponent,
  ],
  template: `
    <div class="page-header">Domains / Hostnames</div>

    <!-- Time filter -->
    <div style="margin-bottom:1rem;">
      <app-time-filter (filterChange)="onFilterChange($event)"></app-time-filter>
    </div>

    <!-- Bar chart -->
    <div class="chart-card" style="margin-bottom:1.5rem;">
      <div class="card-title">Top Domains by Occurrence</div>
      <canvas baseChart [data]="barData" [options]="barOpts" type="bar" style="max-height:260px;"></canvas>
    </div>

    <!-- Search filters -->
    <div class="card" style="margin-bottom:1rem;" [formGroup]="filters">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0.75rem;">
        <mat-form-field appearance="outline">
          <mat-label>Search Domain</mat-label>
          <input matInput formControlName="search" placeholder="e.g. google.com">
          <mat-icon matSuffix>search</mat-icon>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Source IP</mat-label>
          <input matInput formControlName="src_ip" placeholder="e.g. 192.168.1.1">
        </mat-form-field>
      </div>
      <div style="display:flex;gap:0.75rem;margin-top:0.5rem;align-items:center;">
        <button mat-flat-button color="primary" (click)="search()">
          <mat-icon>search</mat-icon> Search
        </button>
        <button mat-stroked-button (click)="reset()">
          <mat-icon>clear</mat-icon> Reset
        </button>
        <span style="margin-left:auto;color:#64748b;font-size:0.85rem;">
          {{ total() | number }} hostname records
        </span>
      </div>
    </div>

    <!-- Table -->
    <div class="card" style="overflow:auto;">
      <div *ngIf="loading()" style="text-align:center;padding:2rem;">
        <mat-spinner diameter="40" style="margin:auto;"></mat-spinner>
      </div>

      <table *ngIf="!loading()" mat-table [dataSource]="rows()" style="width:100%;background:transparent;min-width:900px;">
        <ng-container matColumnDef="hostname">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Hostname / Domain</th>
          <td mat-cell *matCellDef="let r" style="font-family:monospace;font-size:0.85rem;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" [matTooltip]="r.hostname">
            {{ r.hostname }}
          </td>
        </ng-container>
        <ng-container matColumnDef="flow_id">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Flow ID</th>
          <td mat-cell *matCellDef="let r">
            <button *ngIf="r.flow_id" mat-stroked-button
                    style="height:26px;line-height:26px;font-size:0.78rem;padding:0 8px;min-width:0;font-family:monospace;"
                    (click)="openFlow(r.flow_id)">
              #{{ r.flow_id }}
            </button>
            <span *ngIf="!r.flow_id" style="color:#475569;">—</span>
          </td>
        </ng-container>
        <ng-container matColumnDef="src_ip">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Source IP</th>
          <td mat-cell *matCellDef="let r" style="font-family:monospace;font-size:0.85rem;">{{ r.src_ip || '—' }}</td>
        </ng-container>
        <ng-container matColumnDef="subscriber">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Subscriber</th>
          <td mat-cell *matCellDef="let r" style="font-size:0.85rem;">
            <span *ngIf="r.subscriber_id !== 'unknown'" style="color:#818cf8;font-weight:500;">{{ r.subscriber_id }}</span>
            <span *ngIf="r.subscriber_id === 'unknown'" style="color:#475569;font-style:italic;">unknown</span>
          </td>
        </ng-container>
        <ng-container matColumnDef="application">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Application</th>
          <td mat-cell *matCellDef="let r" style="font-size:0.85rem;">
            {{ r.application || '—' }}
            <span *ngIf="r.application_category" style="color:#64748b;font-size:0.75rem;"> ({{ r.application_category }})</span>
          </td>
        </ng-container>
        <ng-container matColumnDef="count">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Resolutions</th>
          <td mat-cell *matCellDef="let r" style="font-size:0.85rem;">{{ r.resolution_count | number }}</td>
        </ng-container>
        <ng-container matColumnDef="last_seen">
          <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Last Seen</th>
          <td mat-cell *matCellDef="let r" style="font-size:0.8rem;color:#94a3b8;">{{ r.last_seen | date:'MM/dd HH:mm' }}</td>
        </ng-container>
        <tr mat-header-row *matHeaderRowDef="cols"></tr>
        <tr mat-row *matRowDef="let row; columns: cols;"></tr>
      </table>

      <mat-paginator [length]="total()" [pageSize]="pageSize" [pageSizeOptions]="[25, 50, 100]"
        (page)="onPage($event)" style="background:transparent;color:#94a3b8;"></mat-paginator>
    </div>
  `,
})
export class DomainsComponent implements OnInit {
  private api    = inject(ApiService);
  private fb     = inject(FormBuilder);
  private dialog = inject(MatDialog);

  cols     = ['hostname', 'flow_id', 'src_ip', 'subscriber', 'application', 'count', 'last_seen'];
  rows     = signal<any[]>([]);
  total    = signal(0);
  loading  = signal(false);
  pageSize = 50;
  offset   = 0;
  activeFilter = signal<TimeFilter>({ start: null, end: null });

  filters = this.fb.group({ search: [''], src_ip: [''] });

  barData: ChartData<'bar'> = {
    labels: [],
    datasets: [{
      data: [], label: 'Occurrences',
      backgroundColor: 'rgba(99,102,241,0.7)',
      borderColor: '#6366f1', borderWidth: 1,
    }],
  };

  barOpts: ChartConfiguration['options'] = {
    indexAxis: 'y',
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: '#64748b' }, grid: { color: '#1e2233' } },
      y: { ticks: { color: '#e2e8f0', font: { size: 11 } }, grid: { color: '#1e2233' } },
    },
  };

  ngOnInit() {
    this.load();
    this.loadChart();
  }

  onFilterChange(f: TimeFilter) { this.activeFilter.set(f); this.offset = 0; this.load(); this.loadChart(); }
  search() { this.offset = 0; this.load(); }
  reset() { this.filters.reset({ search: '', src_ip: '' }); this.offset = 0; this.load(); }
  onPage(e: PageEvent) { this.pageSize = e.pageSize; this.offset = e.pageIndex * e.pageSize; this.load(); }

  openFlow(id: number) {
    this.api.getFlow(id).subscribe(flow => {
      const ref = this.dialog.open(FlowDetailModalComponent, {
        width: '90vw', maxWidth: '700px', maxHeight: '90vh', panelClass: 'dark-dialog',
      });
      ref.componentInstance.data = flow;
    });
  }

  private buildFilterParams() {
    const f  = this.filters.getRawValue();
    const tf = this.activeFilter();
    const p: Record<string, any> = {};
    if (f.search) p['search'] = f.search;
    if (f.src_ip) p['src_ip'] = f.src_ip;
    if (tf.start) p['start']  = tf.start;
    if (tf.end)   p['end']    = tf.end;
    return p;
  }

  private load() {
    this.loading.set(true);
    this.api.getDomains({ ...this.buildFilterParams(), limit: this.pageSize, offset: this.offset }).subscribe({
      next: (res: any) => { this.rows.set(res.rows); this.total.set(res.total); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  private loadChart() {
    this.api.getDomainsChart({ ...this.buildFilterParams(), limit: 20 }).subscribe(data => {
      this.barData = {
        labels: data.map((r: any) => r.hostname),
        datasets: [{ ...this.barData.datasets[0], data: data.map((r: any) => r.occurrences) }],
      };
    });
  }
}
