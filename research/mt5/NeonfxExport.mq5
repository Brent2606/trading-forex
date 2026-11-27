//+------------------------------------------------------------------+
//| NeonfxExport.mq5                                                 |
//| Writes this broker's own price history for the 16 NEONFX pairs   |
//| to MQL5/Files/neonfx/ so the research scripts can test on it.    |
//| It only reads data: it never opens, changes or closes a trade.   |
//|                                                                  |
//| Files:                                                           |
//|   <PAIR>_H1.csv, <PAIR>_D1.csv  time (server time, seconds),     |
//|       open, high, low, close, tick_volume, spread (points)       |
//|   spreads.csv   average spread per hour of the day, from ticks   |
//|   meta.csv      symbol details, swap rates, history found,       |
//|                 and the server's offset from UTC                 |
//+------------------------------------------------------------------+
#property copyright   "NEONFX"
#property version     "1.00"
#property description "Writes this broker's price history for the 16 NEONFX pairs to MQL5/Files/neonfx. Reads data only; never trades."
#property script_show_inputs

input datetime InpFrom        = D'2000.01.01 00:00'; // Earliest date to ask the server for
input int      InpWaitSeconds = 300;                 // Longest wait per pair and timeframe (seconds)
input int      InpSpreadDays  = 14;                  // Days of ticks used to measure the real spread

string PAIRS[16] = {"EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD", "EURGBP",
                    "EURJPY", "GBPJPY", "AUDJPY", "EURCHF", "EURAUD", "GBPCHF", "CADJPY", "AUDNZD"};

//--- The broker's name for a pair: the plain name, or the pair with a short suffix (EURUSD.a).
string FindSymbol(const string pair)
  {
   if(SymbolSelect(pair, true))
      return pair;
   int total = SymbolsTotal(false);
   for(int i = 0; i < total; i++)
     {
      string s = SymbolName(i, false);
      if(StringFind(s, pair) == 0 && StringLen(s) <= StringLen(pair) + 4 && SymbolSelect(s, true))
         return s;
     }
   return "";
  }

//--- Asks the server for older bars until the history reaches InpFrom, stops growing, or time runs out.
int LoadHistory(const string sym, const ENUM_TIMEFRAMES tf)
  {
   datetime times[];
   uint t0 = GetTickCount();
   int maxBars = (int)TerminalInfoInteger(TERMINAL_MAXBARS);
   int last = -1;
   int same = 0;
   while(!IsStopped() && GetTickCount() - t0 < (uint)InpWaitSeconds * 1000)
     {
      int bars = Bars(sym, tf);
      datetime first = (datetime)SeriesInfoInteger(sym, tf, SERIES_FIRSTDATE);
      if(bars > 0 && first > 0 && first <= InpFrom)
         break;
      if(bars >= maxBars)
         break;
      // Asking for bars older than the oldest one makes the terminal fetch them from the server.
      CopyTime(sym, tf, bars > 0 ? bars : 0, 1000, times);
      if(bars == last)
        {
         if(++same >= 50)   // 10 seconds without a single new bar: this is all the server has
            break;
        }
      else
        {
         same = 0;
         last = bars;
        }
      Sleep(200);
     }
   return Bars(sym, tf);
  }

//--- Writes one pair and timeframe; returns the number of finished bars written.
int ExportRates(const string pair, const string sym, const ENUM_TIMEFRAMES tf, const string tfName, datetime &first)
  {
   LoadHistory(sym, tf);
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(sym, tf, 0, Bars(sym, tf), r);
   if(n <= 1)
     {
      PrintFormat("%s %s: no history (error %d)", pair, tfName, GetLastError());
      return 0;
     }
   string name = "neonfx\\" + pair + "_" + tfName + ".csv";
   int h = FileOpen(name, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
     {
      PrintFormat("%s: cannot write %s (error %d)", pair, name, GetLastError());
      return 0;
     }
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   FileWriteString(h, "time,open,high,low,close,tick_volume,spread_points\n");
   // The last bar is still forming: leave it out.
   for(int i = 0; i < n - 1; i++)
      FileWriteString(h, IntegerToString((long)r[i].time) + "," +
                      DoubleToString(r[i].open, digits) + "," +
                      DoubleToString(r[i].high, digits) + "," +
                      DoubleToString(r[i].low, digits) + "," +
                      DoubleToString(r[i].close, digits) + "," +
                      IntegerToString(r[i].tick_volume) + "," +
                      IntegerToString(r[i].spread) + "\n");
   FileClose(h);
   first = r[0].time;
   return n - 1;
  }

//--- Average spread (in points) per server hour over the last InpSpreadDays days, from real ticks.
void MeasureSpreads(const string pair, const string sym, const int fh)
  {
   MqlTick ticks[];
   long toMsc = (long)TimeTradeServer() * 1000;
   long fromMsc = toMsc - (long)InpSpreadDays * 86400 * 1000;
   int n = -1;
   for(int attempt = 0; attempt < 10 && n <= 0 && !IsStopped(); attempt++)
     {
      ResetLastError();
      n = CopyTicksRange(sym, ticks, COPY_TICKS_INFO, (ulong)fromMsc, (ulong)toMsc);
      if(n <= 0)
         Sleep(3000);
     }
   if(n <= 0)
     {
      PrintFormat("%s: no ticks for the spread measurement (error %d)", pair, GetLastError());
      return;
     }
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double sum[24];
   long cnt[24];
   ArrayInitialize(sum, 0.0);
   ArrayInitialize(cnt, 0);
   for(int i = 0; i < n; i++)
     {
      if(ticks[i].bid <= 0 || ticks[i].ask <= 0 || ticks[i].ask < ticks[i].bid)
         continue;
      MqlDateTime t;
      TimeToStruct(ticks[i].time, t);
      sum[t.hour] += (ticks[i].ask - ticks[i].bid) / point;
      cnt[t.hour]++;
     }
   for(int hr = 0; hr < 24; hr++)
      if(cnt[hr] > 0)
         FileWriteString(fh, pair + "," + IntegerToString(hr) + "," + IntegerToString(cnt[hr]) + "," +
                         DoubleToString(sum[hr] / cnt[hr], 2) + "\n");
  }

void OnStart()
  {
   FolderCreate("neonfx");
   long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string modeName = mode == ACCOUNT_TRADE_MODE_DEMO ? "demo" : (mode == ACCOUNT_TRADE_MODE_CONTEST ? "contest" : "real");
   long offset = (long)(TimeTradeServer() - TimeGMT());

   int meta = FileOpen("neonfx\\meta.csv", FILE_WRITE | FILE_TXT | FILE_ANSI);
   int spr = FileOpen("neonfx\\spreads.csv", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(meta == INVALID_HANDLE || spr == INVALID_HANDLE)
     {
      PrintFormat("Cannot write to MQL5/Files/neonfx (error %d)", GetLastError());
      return;
     }
   FileWriteString(meta, "# company=" + AccountInfoString(ACCOUNT_COMPANY) +
                   ";server=" + AccountInfoString(ACCOUNT_SERVER) +
                   ";account=" + modeName +
                   ";server_minus_utc_seconds=" + IntegerToString(offset) +
                   ";exported_server_time=" + IntegerToString((long)TimeTradeServer()) +
                   ";max_bars=" + IntegerToString(TerminalInfoInteger(TERMINAL_MAXBARS)) + "\n");
   FileWriteString(meta, "pair,symbol,digits,point,contract_size,swap_mode,swap_long,swap_short,swap_3day,spread_now_points," +
                   "server_first_date,h1_bars,h1_first,d1_bars,d1_first\n");
   FileWriteString(spr, "pair,server_hour,ticks,mean_spread_points\n");

   int done = 0;
   for(int k = 0; k < ArraySize(PAIRS) && !IsStopped(); k++)
     {
      string pair = PAIRS[k];
      string sym = FindSymbol(pair);
      if(sym == "")
        {
         PrintFormat("%s: not offered by this broker", pair);
         continue;
        }
      Comment(StringFormat("NEONFX export: %s (%d of %d)...", pair, k + 1, ArraySize(PAIRS)));
      datetime h1First = 0, d1First = 0;
      int h1 = ExportRates(pair, sym, PERIOD_H1, "H1", h1First);
      int d1 = ExportRates(pair, sym, PERIOD_D1, "D1", d1First);
      MeasureSpreads(pair, sym, spr);
      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      FileWriteString(meta, pair + "," + sym + "," + IntegerToString(digits) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_POINT), digits) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 0) + "," +
                      EnumToString((ENUM_SYMBOL_SWAP_MODE)SymbolInfoInteger(sym, SYMBOL_SWAP_MODE)) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_SWAP_LONG), 4) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_SWAP_SHORT), 4) + "," +
                      EnumToString((ENUM_DAY_OF_WEEK)SymbolInfoInteger(sym, SYMBOL_SWAP_ROLLOVER3DAYS)) + "," +
                      IntegerToString(SymbolInfoInteger(sym, SYMBOL_SPREAD)) + "," +
                      IntegerToString(SeriesInfoInteger(sym, PERIOD_H1, SERIES_SERVER_FIRSTDATE)) + "," +
                      IntegerToString(h1) + "," + IntegerToString((long)h1First) + "," +
                      IntegerToString(d1) + "," + IntegerToString((long)d1First) + "\n");
      FileFlush(meta);
      FileFlush(spr);
      PrintFormat("%s (%s): %d hourly bars from %s, %d daily bars from %s", pair, sym, h1, TimeToString(h1First, TIME_DATE), d1, TimeToString(d1First, TIME_DATE));
      done++;
     }
   FileClose(meta);
   FileClose(spr);
   Comment(StringFormat("NEONFX export finished: %d pairs written to MQL5/Files/neonfx", done));
   PrintFormat("NEONFX export finished: %d pairs", done);
  }
//+------------------------------------------------------------------+
