import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { BseDividendService, DividendCompany } from './bse-dividend.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit {
  private readonly service = inject(BseDividendService);

  dividends: DividendCompany[] = [];
  loading = false;
  error = '';
  fromDate = '';
  toDate = '';
  lastUpdated = '';

  ngOnInit(): void {
    this.loadDividends();
  }

  loadDividends(): void {
    this.loading = true;
    this.error = '';

    const today = new Date();
    const end = new Date(today);
    end.setDate(end.getDate() + 60);

    this.fromDate = this.formatDisplayDate(today);
    this.toDate = this.formatDisplayDate(end);

    const fromApi = this.formatApiDate(today);
    const toApi = this.formatApiDate(end);

    this.service.getDividends(fromApi, toApi).subscribe({
      next: data => {
        this.dividends = data;
        this.loading = false;
        this.lastUpdated = this.formatDateTime(new Date());
      },
      error: err => {
        console.error('Dividend API error:', err);
        this.dividends = [];
        this.loading = false;
        this.error = err?.error?.error || 'Unable to load BSE dividend data.';
      }
    });
  }

  refresh(): void {
    this.loadDividends();
  }

  trackByCode(index: number, company: DividendCompany): string {
    return company.scrip_code || `${index}`;
  }

  formatPrice(price: number | null | undefined): string {
    if (price === null || price === undefined || !Number.isFinite(Number(price))) {
      return '-';
    }

    return `₹${Number(price).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  formatDividend(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return '-';
    }

    return `₹${Number(value).toFixed(2)}`;
  }

  formatYield(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return '-';
    }

    return `${Number(value).toFixed(2)}%`;
  }

  yieldClass(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return 'yield-none';
    }

    const n = Number(value);

    if (n >= 5) return 'yield-high';
    if (n >= 1) return 'yield-medium';
    if (n >= 0.1) return 'yield-low';
    return 'yield-very-low';
  }

  formatUiDate(value: string | null | undefined): string {
    if (!value) return '-';

    const text = String(value).trim();

    if (/^\d{8}$/.test(text)) {
      return this.makeDisplayDate(
        Number(text.slice(0, 4)),
        Number(text.slice(4, 6)),
        Number(text.slice(6, 8))
      );
    }

    const match = text.match(/^([0-9]{1,2})[\s\/-]+([A-Za-z]{3,9}|[0-9]{1,2})[\s\/-]+([0-9]{4})/);
    if (match) {
      const day = Number(match[1]);
      const year = Number(match[3]);
      const monthValue = match[2];
      const month = /^\d+$/.test(monthValue)
        ? Number(monthValue)
        : this.monthNumber(monthValue);

      if (month >= 1 && month <= 12) {
        return this.makeDisplayDate(year, month, day);
      }
    }

    return text;
  }

  private formatApiDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}${month}${day}`;
  }

  private formatDisplayDate(date: Date): string {
    return this.makeDisplayDate(
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate()
    );
  }

  private makeDisplayDate(year: number, month: number, day: number): string {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${String(day).padStart(2, '0')}-${months[month - 1]}-${year}`;
  }

  private monthNumber(value: string): number {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    return months.indexOf(value.slice(0, 3).toLowerCase()) + 1;
  }

  private formatDateTime(date: Date): string {
    return `${this.formatDisplayDate(date)} ${date.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })}`;
  }
}
