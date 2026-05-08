import { Component, inject, OnInit, signal } from '@angular/core';
import { NgIf, NgFor, NgClass, DecimalPipe } from '@angular/common';
import { FormBuilder, Validators, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { MatTableModule } from '@angular/material/table';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from '../../core/services/api.service';

const CSV_MAPPING_COLS = ['pattern_type', 'pattern', 'application'];

const VALID_PATTERN_TYPES = new Set(['hostname_exact', 'hostname_suffix', 'ip_exact', 'ip_cidr']);

function validateImportData(format: string, data: string, requiredCsvCols: string[]): string | null {
  const trimmed = data.trim();
  if (!trimmed) return 'No data provided.';

  if (format === 'json') {
    let parsed: any;
    try { parsed = JSON.parse(trimmed); } catch { return 'Invalid JSON — could not parse file.'; }
    if (!Array.isArray(parsed)) return 'JSON must be an array of objects.';
    if (parsed.length === 0) return 'JSON array is empty.';
    const missing = requiredCsvCols.filter(c => !(c in parsed[0]));
    if (missing.length) return `JSON objects missing required keys: ${missing.join(', ')}`;
    if (requiredCsvCols.includes('pattern_type')) {
      const bad = parsed.find((r: any) => !VALID_PATTERN_TYPES.has(r.pattern_type));
      if (bad) return `Invalid pattern_type "${bad.pattern_type}". Must be: ${[...VALID_PATTERN_TYPES].join(', ')}`;
    }
    return null;
  }

  // CSV validation
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return 'CSV must have a header row and at least one data row.';
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const missing = requiredCsvCols.filter(c => !headers.includes(c));
  if (missing.length) return `CSV header missing required columns: ${missing.join(', ')}. Expected header: ${requiredCsvCols.join(',')}`;
  if (requiredCsvCols.includes('pattern_type')) {
    const ptIdx = headers.indexOf('pattern_type');
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',');
      const pt = cols[ptIdx]?.trim();
      if (pt && !VALID_PATTERN_TYPES.has(pt)) return `Row ${i}: invalid pattern_type "${pt}". Must be: ${[...VALID_PATTERN_TYPES].join(', ')}`;
    }
  }
  return null;
}

@Component({
  selector: 'app-mappings',
  standalone: true,
  imports: [
    NgIf, NgFor, NgClass, DecimalPipe,
    ReactiveFormsModule, FormsModule,
    MatTableModule, MatPaginatorModule, MatFormFieldModule,
    MatInputModule, MatSelectModule, MatButtonModule,
    MatIconModule, MatTabsModule, MatSnackBarModule,
    MatProgressSpinnerModule, MatTooltipModule,
  ],
  template: `
    <div class="page-header">Application Mappings</div>

    <mat-tab-group>
      <!-- ── View / Edit ────────────────────────────────────── -->
      <mat-tab label="All Mappings ({{ total() | number }})">
        <div style="padding-top:1rem;">
          <!-- Search -->
          <div class="card" style="margin-bottom:1rem;display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;">
            <mat-form-field appearance="outline" style="width:220px;">
              <mat-label>Search pattern / app</mat-label>
              <input matInput [(ngModel)]="searchText" (keyup.enter)="search()">
              <mat-icon matSuffix>search</mat-icon>
            </mat-form-field>
            <mat-form-field appearance="outline" style="width:200px;">
              <mat-label>Type</mat-label>
              <mat-select [(ngModel)]="filterType" (selectionChange)="search()">
                <mat-option value="">All types</mat-option>
                <mat-option value="hostname_exact">hostname_exact</mat-option>
                <mat-option value="hostname_suffix">hostname_suffix</mat-option>
                <mat-option value="ip_exact">ip_exact</mat-option>
              </mat-select>
            </mat-form-field>
            <button mat-flat-button color="primary" (click)="search()"><mat-icon>search</mat-icon></button>
            <button mat-stroked-button (click)="resetSearch()"><mat-icon>clear</mat-icon></button>
            <div style="margin-left:auto;display:flex;gap:0.5rem;">
              <button mat-stroked-button (click)="exportMappings('csv')"><mat-icon>download</mat-icon> CSV</button>
              <button mat-stroked-button (click)="exportMappings('json')"><mat-icon>download</mat-icon> JSON</button>
            </div>
          </div>

          <div class="card" style="overflow:auto;">
            <div *ngIf="loading()" style="text-align:center;padding:2rem;"><mat-spinner diameter="36" style="margin:auto;"></mat-spinner></div>
            <table *ngIf="!loading()" mat-table [dataSource]="rows()" style="width:100%;background:transparent;min-width:800px;">
              <ng-container matColumnDef="type">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Type</th>
                <td mat-cell *matCellDef="let r"><span class="badge badge-tcp" style="font-size:0.72rem;">{{ r.pattern_type }}</span></td>
              </ng-container>
              <ng-container matColumnDef="pattern">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Pattern</th>
                <td mat-cell *matCellDef="let r" style="font-family:monospace;font-size:0.85rem;">{{ r.pattern }}</td>
              </ng-container>
              <ng-container matColumnDef="application">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Application</th>
                <td mat-cell *matCellDef="let r" style="font-weight:500;font-size:0.85rem;">{{ r.application }}</td>
              </ng-container>
              <ng-container matColumnDef="category">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Category</th>
                <td mat-cell *matCellDef="let r" style="font-size:0.85rem;color:#94a3b8;">{{ r.category || '—' }}</td>
              </ng-container>
              <ng-container matColumnDef="priority">
                <th mat-header-cell *matHeaderCellDef style="color:#64748b;">Priority</th>
                <td mat-cell *matCellDef="let r" style="font-size:0.85rem;">{{ r.priority }}</td>
              </ng-container>
              <ng-container matColumnDef="actions">
                <th mat-header-cell *matHeaderCellDef></th>
                <td mat-cell *matCellDef="let r">
                  <button mat-icon-button color="warn" (click)="deleteMapping(r.id)" matTooltip="Delete">
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
        </div>
      </mat-tab>

      <!-- ── Add Single ─────────────────────────────────────── -->
      <mat-tab label="Add Mapping">
        <div style="padding-top:1.5rem;max-width:600px;" [formGroup]="addForm">
          <div class="card">
            <div class="card-title">New Application Mapping</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.75rem;">
              <mat-form-field appearance="outline" style="grid-column:1/-1;">
                <mat-label>Pattern Type</mat-label>
                <mat-select formControlName="pattern_type">
                  <mat-option value="hostname_suffix">hostname_suffix — match host and subdomains</mat-option>
                  <mat-option value="hostname_exact">hostname_exact — exact match only</mat-option>
                  <mat-option value="ip_exact">ip_exact — exact IPv4 address</mat-option>
                  <mat-option value="ip_cidr">ip_cidr — IPv4 CIDR range (e.g. 1.2.3.0/24)</mat-option>
                </mat-select>
              </mat-form-field>
              <mat-form-field appearance="outline" style="grid-column:1/-1;">
                <mat-label>Pattern</mat-label>
                <input matInput formControlName="pattern" placeholder="e.g. example.com or 1.2.3.4">
                <mat-hint>For hostname_suffix: subdomains also match. Stored lowercase.</mat-hint>
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Application Name</mat-label>
                <input matInput formControlName="application" placeholder="e.g. MyApp">
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Category</mat-label>
                <input matInput formControlName="category" placeholder="e.g. Productivity">
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Priority</mat-label>
                <input matInput type="number" formControlName="priority">
                <mat-hint>Higher = evaluated first. Default 100.</mat-hint>
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Notes (optional)</mat-label>
                <input matInput formControlName="notes">
              </mat-form-field>
            </div>
            <div style="margin-top:1rem;">
              <button mat-flat-button color="primary" (click)="addMapping()" [disabled]="addForm.invalid">
                <mat-icon>add</mat-icon> Add Mapping
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
                CSV header: <code style="color:#94a3b8;">pattern_type,pattern,application,category,priority</code>
              </div>
              <div style="font-size:0.8rem;color:#64748b;margin-bottom:0.75rem;" *ngIf="importFormat==='json'">
                JSON: array of objects with keys: pattern_type, pattern, application, category, priority
              </div>
              <textarea [(ngModel)]="importData" rows="10"
                        style="width:100%;background:#12151e;border:1px solid #2d3148;border-radius:8px;color:#e2e8f0;padding:0.75rem;font-family:monospace;font-size:0.82rem;resize:vertical;"
                        placeholder="Paste your CSV or JSON here…"></textarea>
              <div style="margin-top:0.75rem;display:flex;gap:0.75rem;align-items:center;">
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
export class MappingsComponent implements OnInit {
  private api   = inject(ApiService);
  private snack = inject(MatSnackBar);
  private fb    = inject(FormBuilder);

  cols     = ['type', 'pattern', 'application', 'category', 'priority', 'actions'];
  rows     = signal<any[]>([]);
  total    = signal(0);
  loading  = signal(false);
  importing = signal(false);
  pageSize = 100;
  offset   = 0;
  searchText  = '';
  filterType  = '';
  importFormat = 'csv';
  importData   = '';
  importResult = signal<string | null>(null);

  addForm = this.fb.group({
    pattern_type: ['hostname_suffix', Validators.required],
    pattern:      ['', Validators.required],
    application:  ['', Validators.required],
    category:     [''],
    priority:     [100],
    notes:        [''],
  });

  ngOnInit() { this.load(); }

  search() { this.offset = 0; this.load(); }
  resetSearch() { this.searchText = ''; this.filterType = ''; this.offset = 0; this.load(); }
  onPage(e: PageEvent) { this.pageSize = e.pageSize; this.offset = e.pageIndex * e.pageSize; this.load(); }

  private load() {
    this.loading.set(true);
    const p: Record<string, any> = { limit: this.pageSize, offset: this.offset };
    if (this.searchText) p['search']       = this.searchText;
    if (this.filterType) p['pattern_type'] = this.filterType;
    this.api.getMappings(p).subscribe({
      next: (r: any) => { this.rows.set(r.rows); this.total.set(r.total); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }

  addMapping() {
    if (this.addForm.invalid) return;
    this.api.createMapping(this.addForm.getRawValue()).subscribe({
      next: () => {
        this.snack.open('Mapping added', 'OK', { duration: 3000 });
        this.addForm.reset({ pattern_type: 'hostname_suffix', priority: 100 });
        this.load();
      },
      error: err => this.snack.open('Error: ' + (err.error?.error || err.message), 'OK', { duration: 4000 }),
    });
  }

  deleteMapping(id: number) {
    this.api.deleteMapping(id).subscribe({ next: () => this.load(), error: () => {} });
  }

  exportMappings(fmt: 'csv' | 'json') {
    const token = localStorage.getItem('token') || '';
    const url   = this.api.exportMappingsUrl(fmt);
    // Open with Authorization header via a fetch + blob download
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `application_mappings.${fmt}`;
        a.click();
      });
  }

  loadFile(event: any) {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate extension matches selected format
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (ext !== this.importFormat) {
      this.importResult.set(`Error: file extension ".${ext}" does not match selected format "${this.importFormat}". Please select the correct format or upload a matching file.`);
      (event.target as HTMLInputElement).value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = e => {
      const raw = (e.target?.result as string) || '';
      const err = validateImportData(this.importFormat, raw, CSV_MAPPING_COLS);
      if (err) {
        this.importResult.set('Error: ' + err);
        this.importData = '';
      } else {
        this.importData = raw;
        this.importResult.set(null);
      }
    };
    reader.readAsText(file);
  }

  runImport() {
    if (!this.importData.trim()) return;
    const err = validateImportData(this.importFormat, this.importData, CSV_MAPPING_COLS);
    if (err) { this.importResult.set('Error: ' + err); return; }
    this.importing.set(true);
    this.importResult.set(null);
    this.api.importMappings(this.importFormat, this.importData).subscribe({
      next: (r: any) => {
        this.importResult.set(`✓ Imported ${r.inserted}, skipped ${r.skipped} of ${r.total}`);
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
