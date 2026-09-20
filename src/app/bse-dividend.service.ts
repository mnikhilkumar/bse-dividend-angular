import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface DividendCompany {
  scrip_code: string;
  short_name: string;
  long_name: string;
  RD_Date: string;
  Purpose: string;
  BCRD_FROM: string;
  BCRD_TO: string;
  ND_START_DATE: string;
  ND_END_DATE: string;
  payment_date: string;
  exdate: string;
  latest_price: number | null;
  dividend_per_share: number | null;
  dividend_yield: number | null;
}

@Injectable({ providedIn: 'root' })
export class BseDividendService {
  private readonly http = inject(HttpClient);

  getDividends(fromDate: string, toDate: string): Observable<DividendCompany[]> {
    const params = new HttpParams()
      .set('Fdate', fromDate)
      .set('TDate', toDate)
      .set('Purposecode', 'P9')
      .set('ddlcategorys', 'E');

    return this.http.get<DividendCompany[]>('/api/dividends', { params });
  }
}
