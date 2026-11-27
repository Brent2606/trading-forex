//+------------------------------------------------------------------+
//| NeonfxExportMarkets.mq5                                          |
//| Writes this broker's own price history for gold, silver, oil and |
//| the large stock indices to MQL5/Files/neonfx_markets/ so the     |
//| research scripts can test on it.                                 |
//| It only reads data: it never opens, changes or closes a trade.   |
//|                                                                  |
//| Files:                                                           |
//|   <NAME>_H1.csv, _D1.csv, _M15.csv  time (server time, seconds), |
//|       open, high, low, close, tick_volume, spread (points)       |
//|   spreads.csv   spread per hour of the day, measured from ticks: |
//|                 per tick, per second, and in the first minute    |
//|   sessions.csv  the hours in which each market can be traded     |
//|   meta.csv      symbol details, swap rates, history found,       |
//|                 and the server's offset from UTC                 |
//|   symbols.csv   every symbol this server offers (names only)     |
//|   done.txt      written last: the export is complete             |
//+------------------------------------------------------------------+
#property copyright   "NEONFX"
#property version     "1.00"
#property description "Writes this broker's price history for gold, silver, oil and the large stock indices to MQL5/Files/neonfx_markets. Reads data only; never trades."
#property script_show_inputs

input datetime InpFrom        = D'2000.01.01 00:00'; // Earliest date to ask the server for
input int      InpWaitSeconds = 300;                 // Longest wait per market and timeframe (seconds)
input int      InpSpreadDays  = 21;                  // Days of ticks used to measure the real spread

#define FOLDER "neonfx_markets\\"

//--- Our name for a market, and the names brokers use for it (the first one found is taken).
string MARKETS[15][2] =
  {
     {"XAUUSD",  "XAUUSD|GOLD"},
     {"XAGUSD",  "XAGUSD|SILVER"},
     {"XTIUSD",  "XTIUSD|USOIL|WTI|SpotCrude"},
     {"XBRUSD",  "XBRUSD|UKOIL|BRENT|SpotBrent"},
     {"US500",   "US500|SPX500|SP500|USA500"},
     {"USTEC",   "USTEC|NAS100|US100|USTECH"},
     {"US30",    "US30|DJ30|WS30|USA30"},
     {"US2000",  "US2000|RUSS2000|USSMALL"},
     {"DE40",    "DE40|GER40|DE30|GER30|DAX40"},
     {"UK100",   "UK100|FTSE100|GB100"},
     {"F40",     "F40|FRA40|FR40|CAC40"},
     {"STOXX50", "STOXX50|EUSTX50|EU50|EUR50"},
     {"JP225",   "JP225|JPN225|JAP225|NIK225"},
     {"AUS200",  "AUS200|AU200"},
     {"HK50",    "HK50|HSI50|HKG50"}
  };

//--- Commas would break a CSV line.
string Clean(string s)
  {
   StringReplace(s, ",", " ");
   StringReplace(s, "\n", " ");
   StringReplace(s, "\r", " ");
   return s;
  }

//--- The broker's symbol for a market: one of the names exactly, or a name with a short suffix (US500.a).
//--- A name followed by "_" is a futures contract with its own short history: never taken.
string FindSymbol(const string names)
  {
   string cand[];
   int k = StringSplit(names, '|', cand);
   for(int c = 0; c < k; c++)
      if(SymbolSelect(cand[c], true))
         return cand[c];
   int total = SymbolsTotal(false);
   for(int c = 0; c < k; c++)
      for(int i = 0; i < total; i++)
        {
         string s = SymbolName(i, false);
         if(StringFind(s, cand[c]) != 0 || StringLen(s) > StringLen(cand[c]) + 5)
            continue;
         string rest = StringSubstr(s, StringLen(cand[c]));
         if(StringFind(rest, "_") >= 0 || StringFind(rest, "-") >= 0)
            continue;
         if(SymbolSelect(s, true))
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
         if(++same >= 75)   // 15 seconds without a single new bar: this is all the server has
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

//--- Writes one market and timeframe; returns the number of finished bars written.
int ExportRates(const string name, const string sym, const ENUM_TIMEFRAMES tf, const string tfName, datetime &first)
  {
   LoadHistory(sym, tf);
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int n = CopyRates(sym, tf, 0, Bars(sym, tf), r);
   if(n <= 1)
     {
      PrintFormat("%s %s: no history (error %d)", name, tfName, GetLastError());
      return 0;
     }
   string file = FOLDER + name + "_" + tfName + ".csv";
   int h = FileOpen(file, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
     {
      PrintFormat("%s: cannot write %s (error %d)", name, file, GetLastError());
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

//--- The spread per hour of the server's clock over the last InpSpreadDays days, from real ticks, three ways:
//---   per tick      the average over all ticks (busy moments count more)
//---   per second    the average over time: what somebody entering at an arbitrary moment pays
//---   first minute  the average over time in the first minute of the hour: what an entry on the hour pays
//--- A quote is taken to stand for at most 60 seconds, so closed hours are not counted.
void MeasureSpreads(const string name, const string sym, const int fh)
  {
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double sumTick[24], sumTime[24], durTime[24], sumOpen[24], durOpen[24];
   long cnt[24];
   ArrayInitialize(sumTick, 0.0);
   ArrayInitialize(sumTime, 0.0);
   ArrayInitialize(durTime, 0.0);
   ArrayInitialize(sumOpen, 0.0);
   ArrayInitialize(durOpen, 0.0);
   ArrayInitialize(cnt, 0);
   long endMsc = (long)TimeTradeServer() * 1000;
   long total = 0;
   // One day at a time: a month of ticks at once would not fit in memory.
   for(int d = InpSpreadDays; d >= 1 && !IsStopped(); d--)
     {
      long fromMsc = endMsc - (long)d * 86400 * 1000;
      long toMsc = fromMsc + 86400 * 1000;
      MqlTick ticks[];
      int n = -1;
      for(int attempt = 0; attempt < 5 && n < 0 && !IsStopped(); attempt++)
        {
         ResetLastError();
         n = CopyTicksRange(sym, ticks, COPY_TICKS_INFO, (ulong)fromMsc, (ulong)toMsc);
         if(n < 0)
            Sleep(2000);
        }
      if(n <= 0)
         continue;
      total += n;
      for(int i = 0; i < n; i++)
        {
         if(ticks[i].bid <= 0 || ticks[i].ask <= 0 || ticks[i].ask < ticks[i].bid)
            continue;
         double sp = (ticks[i].ask - ticks[i].bid) / point;
         long t = ticks[i].time_msc;
         int hr = (int)((t / 3600000) % 24);
         long inHour = t % 3600000;
         // How long this quote stood: until the next tick, the end of the hour, or 60 seconds.
         long stand = (i + 1 < n) ? ticks[i + 1].time_msc - t : 0;
         if(stand > 60000)
            stand = 60000;
         if(stand > 3600000 - inHour)
            stand = 3600000 - inHour;
         if(stand < 0)
            stand = 0;
         sumTick[hr] += sp;
         cnt[hr]++;
         sumTime[hr] += sp * stand;
         durTime[hr] += (double)stand;
         if(inHour < 60000)
           {
            long part = stand < 60000 - inHour ? stand : 60000 - inHour;
            sumOpen[hr] += sp * part;
            durOpen[hr] += (double)part;
           }
        }
      ArrayFree(ticks);
     }
   if(total == 0)
     {
      PrintFormat("%s: no ticks for the spread measurement (error %d)", name, GetLastError());
      return;
     }
   for(int hr = 0; hr < 24; hr++)
      if(cnt[hr] > 0)
         FileWriteString(fh, name + "," + IntegerToString(hr) + "," + IntegerToString(cnt[hr]) + "," +
                         DoubleToString(sumTick[hr] / cnt[hr], 2) + "," +
                         (durTime[hr] > 0 ? DoubleToString(sumTime[hr] / durTime[hr], 2) : "") + "," +
                         DoubleToString(durTime[hr] / 1000.0, 0) + "," +
                         (durOpen[hr] > 0 ? DoubleToString(sumOpen[hr] / durOpen[hr], 2) : "") + "," +
                         DoubleToString(durOpen[hr] / 1000.0, 0) + "\n");
  }

//--- The hours of the week in which the market gives quotes and can be traded (seconds from midnight, server time).
void WriteSessions(const string name, const string sym, const int fh)
  {
   for(int day = 0; day < 7; day++)
     {
      datetime from, to;
      for(uint idx = 0; idx < 10 && SymbolInfoSessionTrade(sym, (ENUM_DAY_OF_WEEK)day, idx, from, to); idx++)
         FileWriteString(fh, name + ",trade," + IntegerToString(day) + "," + IntegerToString((long)from) + "," + IntegerToString((long)to) + "\n");
      for(uint idx = 0; idx < 10 && SymbolInfoSessionQuote(sym, (ENUM_DAY_OF_WEEK)day, idx, from, to); idx++)
         FileWriteString(fh, name + ",quote," + IntegerToString(day) + "," + IntegerToString((long)from) + "," + IntegerToString((long)to) + "\n");
     }
  }

//--- Every symbol on this server, so nothing has to be guessed about what the broker offers.
void WriteSymbolList()
  {
   int h = FileOpen(FOLDER + "symbols.csv", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
      return;
   FileWriteString(h, "symbol,path,description,calc_mode,currency_profit,digits,contract_size,trade_mode\n");
   int total = SymbolsTotal(false);
   for(int i = 0; i < total && !IsStopped(); i++)
     {
      string s = SymbolName(i, false);
      FileWriteString(h, Clean(s) + "," + Clean(SymbolInfoString(s, SYMBOL_PATH)) + "," + Clean(SymbolInfoString(s, SYMBOL_DESCRIPTION)) + "," +
                      EnumToString((ENUM_SYMBOL_CALC_MODE)SymbolInfoInteger(s, SYMBOL_TRADE_CALC_MODE)) + "," +
                      SymbolInfoString(s, SYMBOL_CURRENCY_PROFIT) + "," +
                      IntegerToString(SymbolInfoInteger(s, SYMBOL_DIGITS)) + "," +
                      DoubleToString(SymbolInfoDouble(s, SYMBOL_TRADE_CONTRACT_SIZE), 2) + "," +
                      EnumToString((ENUM_SYMBOL_TRADE_MODE)SymbolInfoInteger(s, SYMBOL_TRADE_MODE)) + "\n");
     }
   FileClose(h);
  }

void OnStart()
  {
   FolderCreate("neonfx_markets");
   FileDelete(FOLDER + "done.txt");
   long mode = AccountInfoInteger(ACCOUNT_TRADE_MODE);
   string modeName = mode == ACCOUNT_TRADE_MODE_DEMO ? "demo" : (mode == ACCOUNT_TRADE_MODE_CONTEST ? "contest" : "real");
   long offset = (long)(TimeTradeServer() - TimeGMT());

   Comment("NEONFX markets export: listing the broker's symbols...");
   WriteSymbolList();

   int meta = FileOpen(FOLDER + "meta.csv", FILE_WRITE | FILE_TXT | FILE_ANSI);
   int spr = FileOpen(FOLDER + "spreads.csv", FILE_WRITE | FILE_TXT | FILE_ANSI);
   int ses = FileOpen(FOLDER + "sessions.csv", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(meta == INVALID_HANDLE || spr == INVALID_HANDLE || ses == INVALID_HANDLE)
     {
      PrintFormat("Cannot write to MQL5/Files/neonfx_markets (error %d)", GetLastError());
      return;
     }
   FileWriteString(meta, "# company=" + AccountInfoString(ACCOUNT_COMPANY) +
                   ";server=" + AccountInfoString(ACCOUNT_SERVER) +
                   ";account=" + modeName +
                   ";account_currency=" + AccountInfoString(ACCOUNT_CURRENCY) +
                   ";server_minus_utc_seconds=" + IntegerToString(offset) +
                   ";exported_server_time=" + IntegerToString((long)TimeTradeServer()) +
                   ";max_bars=" + IntegerToString(TerminalInfoInteger(TERMINAL_MAXBARS)) + "\n");
   FileWriteString(meta, "pair,symbol,description,path,digits,point,contract_size,calc_mode,currency_profit,currency_margin," +
                   "tick_size,tick_value,volume_min,volume_step,trade_mode,swap_mode,swap_long,swap_short,swap_3day," +
                   "spread_now_points,bid,ask,server_first_date,h1_bars,h1_first,d1_bars,d1_first,m15_bars,m15_first\n");
   FileWriteString(spr, "pair,server_hour,ticks,mean_spread_points,time_spread_points,seconds,open_spread_points,open_seconds\n");
   FileWriteString(ses, "pair,kind,day_of_week,from_seconds,to_seconds\n");

   int count = ArrayRange(MARKETS, 0);
   int done = 0;
   for(int k = 0; k < count && !IsStopped(); k++)
     {
      string name = MARKETS[k][0];
      string sym = FindSymbol(MARKETS[k][1]);
      if(sym == "")
        {
         PrintFormat("%s: not offered by this broker", name);
         continue;
        }
      Comment(StringFormat("NEONFX markets export: %s (%d of %d)...", name, k + 1, count));
      datetime h1First = 0, d1First = 0, m15First = 0;
      int h1 = ExportRates(name, sym, PERIOD_H1, "H1", h1First);
      int d1 = ExportRates(name, sym, PERIOD_D1, "D1", d1First);
      int m15 = ExportRates(name, sym, PERIOD_M15, "M15", m15First);
      MeasureSpreads(name, sym, spr);
      WriteSessions(name, sym, ses);
      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      FileWriteString(meta, name + "," + Clean(sym) + "," + Clean(SymbolInfoString(sym, SYMBOL_DESCRIPTION)) + "," +
                      Clean(SymbolInfoString(sym, SYMBOL_PATH)) + "," + IntegerToString(digits) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_POINT), digits) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 2) + "," +
                      EnumToString((ENUM_SYMBOL_CALC_MODE)SymbolInfoInteger(sym, SYMBOL_TRADE_CALC_MODE)) + "," +
                      SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT) + "," +
                      SymbolInfoString(sym, SYMBOL_CURRENCY_MARGIN) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE), digits) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 6) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 2) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 2) + "," +
                      EnumToString((ENUM_SYMBOL_TRADE_MODE)SymbolInfoInteger(sym, SYMBOL_TRADE_MODE)) + "," +
                      EnumToString((ENUM_SYMBOL_SWAP_MODE)SymbolInfoInteger(sym, SYMBOL_SWAP_MODE)) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_SWAP_LONG), 4) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_SWAP_SHORT), 4) + "," +
                      EnumToString((ENUM_DAY_OF_WEEK)SymbolInfoInteger(sym, SYMBOL_SWAP_ROLLOVER3DAYS)) + "," +
                      IntegerToString(SymbolInfoInteger(sym, SYMBOL_SPREAD)) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_BID), digits) + "," +
                      DoubleToString(SymbolInfoDouble(sym, SYMBOL_ASK), digits) + "," +
                      IntegerToString(SeriesInfoInteger(sym, PERIOD_H1, SERIES_SERVER_FIRSTDATE)) + "," +
                      IntegerToString(h1) + "," + IntegerToString((long)h1First) + "," +
                      IntegerToString(d1) + "," + IntegerToString((long)d1First) + "," +
                      IntegerToString(m15) + "," + IntegerToString((long)m15First) + "\n");
      FileFlush(meta);
      FileFlush(spr);
      FileFlush(ses);
      PrintFormat("%s (%s): %d hourly bars from %s, %d daily bars from %s, %d quarter-hour bars from %s", name, sym,
                  h1, TimeToString(h1First, TIME_DATE), d1, TimeToString(d1First, TIME_DATE), m15, TimeToString(m15First, TIME_DATE));
      done++;
     }
   FileClose(meta);
   FileClose(spr);
   FileClose(ses);
   if(!IsStopped())
     {
      int fin = FileOpen(FOLDER + "done.txt", FILE_WRITE | FILE_TXT | FILE_ANSI);
      if(fin != INVALID_HANDLE)
        {
         FileWriteString(fin, IntegerToString(done) + " markets, server time " + IntegerToString((long)TimeTradeServer()) + "\n");
         FileClose(fin);
        }
     }
   Comment(StringFormat("NEONFX markets export finished: %d markets written to MQL5/Files/neonfx_markets", done));
   PrintFormat("NEONFX markets export finished: %d markets", done);
  }
//+------------------------------------------------------------------+
