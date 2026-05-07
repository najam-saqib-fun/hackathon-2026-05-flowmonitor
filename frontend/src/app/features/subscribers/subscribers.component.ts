import { Component, inject, OnInit, signal } from '@angular/core';
import { NgIf, NgFor, NgClass, DatePipe } from '@angular/common';
import { FormBuilder, Validators, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialogModule } from '@angular/material/dialog';
import { ApiService } from '../../core/services/api.service';

@Component({
  selector: 'app-subscribers',
  standalone: true,
  imports: [
    NgIf, NgFor, NgClass, DatePipe,
    ReactiveFormsModule, FormsModule,
    MatTableModule, MatPaginatorModule, MatFormFieldModule,
    MatInputModule, MatButtonModule, MatIconModule,
    MatTabsModule, MatSnackBarModule, MatProgressSpinnerModule,
    MatTooltipModule, MatDialogModule,
  ],
  template: `
    <div class="page-header">Subscribers</div>

    <mat-tab-group>
      <!-- ── View / Edit ────────────────────────────────────── -->
      <mat-tab label="All Subscribers ({{ total() }})">
        <div style="padding-top:1rem;">
          <!-- Search -->
          <div class="card" style="margin-bottom:1rem;display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;">
            <mat-form-field appearance="outline" style="width:260px;">
              <mat-label>Search IP / Subscriber ID / Name</mat-label>
              <input matInput [(ngModel)]="searchText" (keyup.enter)="search()">
              <mat-icon matSuffix>search</mat-icon>
            </mat-form-field>
            <button mat-flat-button color="primary" (click)="search()"><mat-icon>search</mat-icon></button>
            <button mat-stroked-button (click)="resetSearch()"><mat-icon>clear</mat-icon></button>
            <div style="margin-left:auto;display:flex;gap:0.5rem;">
              <button mat-stroked-button (click)="exportSubscribers('csv')"><mat-icon>download</mat-icon> CSV</button>
              <button mat-stroked-button (click)="exportSubscribers('json')"><mat-icon>download</mat-icon> JSON</button>
            </div>
          </div>

          <div class="card" style="overflow:auto;">
            <div *ngIf="loading()" style="text-align:center;padding:2rem;">
              <mat-spinner diameter="36" style="margin:auto;"></mat-spinner>
            </div>

            <table *ngIf="!loading()" mat-table [dataSource]="rows()" style="width:100%;background:transparent;min-width:800px;">
              <ng-container matColumnDef="ip_address">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">IP Address</th>
                <td mat-cell *matCellDef="let r" style="font-family:monospace;font-size:0.85rem;">{{ r.ip_address }}</td>
              </ng-container>
              <ng-container matColumnDef="subscriber_id">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Subscriber ID</th>
                <td mat-cell *matCellDef="let r" style="color:#818cf8;font-weight:500;font-size:0.85rem;">{{ r.subscriber_id }}</td>
              </ng-container>
              <ng-container matColumnDef="name">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Name</th>
                <td mat-cell *matCellDef="let r" style="font-size:0.85rem;">{{ r.name || '—' }}</td>
              </ng-container>
              <ng-container matColumnDef="notes">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Notes</th>
                <td mat-cell *matCellDef="let r" style="font-size:0.8rem;color:#94a3b8;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
                    [matTooltip]="r.notes || ''">
                  {{ r.notes || '—' }}
                </td>
              </ng-container>
              <ng-container matColumnDef="created_at">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Added</th>
                <td mat-cell *matCellDef="let r" style="font-size:0.8rem;color:#94a3b8;">{{ r.created_at | date:'MM/dd/yy HH:mm' }}</td>
              </ng-container>
              <ng-container matColumnDef="actions">
                <th mat-header-cell *matHeaderCellDef></th>
                <td mat-cell *matCellDef="let r" style="white-space:nowrap;">
                  <button mat-icon-button color="primary" (click)="startEdit(r)" matTooltip="Edit">
                    <mat-icon>edit</mat-icon>
                  </button>
                  <button mat-icon-button color="warn" (click)="deleteSubscriber(r.id)" matTooltip="Delete">
                    <mat-icon>delete</mat-icon>
                  </button>
                </td>
              </ng-container>
              <tr mat-header-row *matHeaderRowDef="cols"></tr>
              <tr mat-row *matRowDef="let row; columns: cols;"></tr>
            </table>

            <mat-paginator [length]="total()" [pageSize]="pageSize" [pageSizeOptions]="[50, 100, 200]"
              (page)="onPage($event)" style="background:transparent;color:#94a3b8;"></mat-paginator>
          </div>

          <!-- Inline edit panel -->
          <div *ngIf="editRow()" class="card" style="margin-top:1rem;max-width:600px;" [formGroup]="editForm">
            <div class="card-title">Edit Subscriber — {{ editRow()!.ip_address }}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
              <mat-form-field appearance="outline">
                <mat-label>IP Address</mat-label>
                <input matInput formControlName="ip_address">
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Subscriber ID</mat-label>
                <input matInput formControlName="subscriber_id">
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Name</mat-label>
                <input matInput formControlName="name">
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Notes</mat-label>
                <input matInput formControlName="notes">
              </mat-form-field>
            </div>
            <div style="display:flex;gap:0.75rem;margin-top:0.75rem;">
              <button mat-flat-button color="primary" (click)="saveEdit()" [disabled]="editForm.invalid">
                <mat-icon>save</mat-icon> Save
              </button>
              <button mat-stroked-button (click)="cancelEdit()">
                <mat-icon>close</mat-icon> Cancel
              </button>
            </div>
          </div>
        </div>
      </mat-tab>

      <!-- ── Add Single ─────────────────────────────────────── -->
      <mat-tab label="Add Subscriber">
        <div style="padding-top:1.5rem;max-width:600px;" [formGroup]="addForm">
          <div class="card">
            <div class="card-title">New Subscriber Mapping</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
              <mat-form-field appearance="outline">
                <mat-label>IP Address</mat-label>
                <input matInput formControlName="ip_address" placeholder="e.g. 192.168.1.100">
                <mat-hint>Exact IPv4 address</mat-hint>
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Subscriber ID</mat-label>
                <input matInput formControlName="subscriber_id" placeholder="e.g. SUB-0042 or john.doe">
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Name (optional)</mat-label>
                <input matInput formControlName="name" placeholder="e.g. John Doe">
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Notes (optional)</mat-label>
                <input matInput formControlName="notes" placeholder="e.g. Contract #1234">
              </mat-form-field>
            </div>
            <div style="margin-top:1rem;">
              <button mat-flat-button color="primary" (click)="addSubscriber()" [disabled]="addForm.invalid">
                <mat-icon>person_add</mat-icon> Add Subscriber
              </button>
            </div>
          </div>
        </div>
      </mat-tab>

      <!-- ── Bulk Import ────────────────────────────────────── -->
      <mat-tab label="Bulk Import">
        <div style="padding-top:1.5rem;max-width:700px;">
          <div class="card">
            <div class="card-title">Bulk Import</div>
            <div style="margin-bottom:1rem;">
              <div style="display:flex;gap:0.75rem;margin-bottom:0.75rem;align-items:center;">
                <span style="font-size:0.85rem;color:#94a3b8;">Format:</span>
                <button mat-stroked-button [ngClass]="importFormat==='csv'?'active-preset':''" (click)="importFormat='csv'">CSV</button>
                <button mat-stroked-button [ngClass]="importFormat==='json'?'active-preset':''" (click)="importFormat='json'">JSON</button>
              </div>
              <div style="font-size:0.8rem;color:#64748b;margin-bottom:0.75rem;" *ngIf="importFormat==='csv'">
                CSV header: <code style="color:#94a3b8;">ip_address,subscriber_id,name,notes</code>
                <br>Existing IPs are updated (upsert).
              </div>
              <div style="font-size:0.8rem;color:#64748b;margin-bottom:0.75rem;" *ngIf="importFormat==='json'">
                JSON: array of objects with keys: ip_address, subscriber_id, name (opt), notes (opt)
                <br>Existing IPs are updated (upsert).
              </div>
              <textarea [(ngModel)]="importData" rows="10"
                        style="width:100%;background:#12151e;border:1px solid #2d3148;border-radius:8px;color:#e2e8f0;padding:0.75rem;font-family:monospace;font-size:0.82rem;resize:vertical;"
                        placeholder="Paste your CSV or JSON here…"></textarea>
              <div style="margin-top:0.75rem;display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;">
                <button mat-flat-button color="primary" (click)="runImport()" [disabled]="!importData.trim() || importing()">
                  <mat-icon>upload</mat-icon> Import
                </button>
                <label mat-stroked-button style="cursor:pointer;">
                  <mat-icon>folder_open</mat-icon> Load File
                  <input type="file" style="display:none;" accept=".csv,.json" (change)="loadFile($event)">
                </label>
                <span *ngIf="importResult()" [style.color]="importResult()!.startsWith('Error') ? '#f87171' : '#22c55e'">
                  {{ importResult() }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </mat-tab>
    </mat-tab-group>
  `,
  styles: [`.active-preset { background: rgba(99,102,241,0.2) !important; color: #818cf8 !important; border-color: #6366f1 !important; }`],
})
export class SubscribersComponent implements OnInit {
  private api   = inject(ApiService);
  private snack = inject(MatSnackBar);
  private fb    = inject(FormBuilder);

  cols     = ['ip_address', 'subscriber_id', 'name', 'notes', 'created_at', 'actions'];
  rows     = signal<any[]>([]);
  total    = signal(0);
  loading  = signal(false);
  importing = signal(false);
  pageSize = 100;
  offset   = 0;
  searchText  = '';
  importFormat = 'csv';
  importData   = '';
  importResult = signal<string | null>(null);
  editRow  = signal<any | null>(null);

  addForm = this.fb.group({
    ip_address:    ['', Validators.required],
    subscriber_id: ['', Validators.required],
    name:          [''],
    notes:         [''],
  });

  editForm = this.fb.group({
    ip_address:    ['', Validators.required],
    subscriber_id: ['', Validators.required],
    name:          [''],
    notes:         [''],
  });

  ngOnInit() { this.load(); }

  search() { this.offset = 0; this.load(); }
  resetSearch() { this.searchText = ''; this.offset = 0; this.load(); }
  onPage(e: PageEvent) { this.pageSize = e.pageSize; this.offset = e.pageIndex * e.pageSize; this.load(); }

  private load() {
    this.loading.set(true);
    const p: Record<string, any> = { limit: this.pageSize, offset: this.offset };
    if (this.searchText) p['search'] = this.searchText;
    this.api.getSubscribers(p).subscribe({
      next: (r: any) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  addSubscriber() {
    if (this.addForm.invalid) return;
    this.api.createSubscriber(this.addForm.getRawValue()).subscribe({
      next: () => {
        this.snack.open('Subscriber added', 'OK', { duration: 3000 });
        this.addForm.reset();
        this.load();
      },
      error: err => this.snack.open('Error: ' + (err.error?.error || err.message), 'OK', { duration: 4000 }),
    });
  }

  startEdit(row: any) {
    this.editRow.set(row);
    this.editForm.patchValue({
      ip_address:    row.ip_address,
      subscriber_id: row.subscriber_id,
      name:          row.name || '',
      notes:         row.notes || '',
    });
  }

  cancelEdit() { this.editRow.set(null); }

  saveEdit() {
    if (this.editForm.invalid || !this.editRow()) return;
    this.api.updateSubscriber(this.editRow()!.id, this.editForm.getRawValue()).subscribe({
      next: () => {
        this.snack.open('Subscriber updated', 'OK', { duration: 3000 });
        this.editRow.set(null);
        this.load();
      },
      error: err => this.snack.open('Error: ' + (err.error?.error || err.message), 'OK', { duration: 4000 }),
    });
  }

  deleteSubscriber(id: number) {
    this.api.deleteSubscriber(id).subscribe({ next: () => this.load(), error: () => {} });
  }

  exportSubscribers(fmt: 'csv' | 'json') {
    const token = localStorage.getItem('token') || '';
    const url   = this.api.exportSubscribersUrl(fmt);
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `subscribers.${fmt}`;
        a.click();
      });
  }

  loadFile(event: any) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => { this.importData = (e.target?.result as string) || ''; };
    reader.readAsText(file);
  }

  runImport() {
    if (!this.importData.trim()) return;
    this.importing.set(true);
    this.importResult.set(null);
    this.api.importSubscribers(this.importFormat, this.importData).subscribe({
      next: (r: any) => {
        this.importResult.set(`✓ Imported ${r.inserted} new, updated ${r.updated} of ${r.total}`);
        this.importing.set(false);
        this.load();
      },
      error: err => {
        this.importResult.set('Error: ' + (err.error?.error || err.message));
        this.importing.set(false);
      },
    });
  }
}
