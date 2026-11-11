package xyz.sintfoap.scanner

import java.time.LocalDate
import java.time.YearMonth

/**
 * Reading an expiry date off a package, from the text the camera sees
 * ("BEST BY 05/10/27", "EXP 10MAY27", "USE BY 2027-05-10", "BB MAY 10 2027").
 *
 * Numbers are read month first, as US packages print them, unless the first
 * can't be a month (25/12/27). A date with only a month and year means the end
 * of that month. A date near words like EXP or BEST BY wins over others (a
 * package can also say when it was packed); otherwise the latest one does.
 * Dates long past, or years away, aren't expiry dates and are left out.
 */
object Dates {
    private val MONTHS = listOf("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
    private const val MON = "(JAN|FEB|MAR|APR|MAY|JUNE?|JULY?|AUG|SEPT?|OCT|NOV|DEC)[A-Z]*\\.?"
    private val KEYWORD = Regex("\\b(EXP(IRES|IRY|\\.)?|BEST\\s*(BY|BEFORE|IF\\s*USED\\s*BY)|BB|USE\\s*BY|SELL\\s*BY|BBE|ENJOY\\s*BY|FRESH\\s*THRU)\\b")
    private val PATTERNS: List<Pair<Regex, (MatchResult) -> LocalDate?>> = listOf(
        // 2027-05-10
        Regex("\\b(20\\d{2})[-./](\\d{1,2})[-./](\\d{1,2})\\b") to { m -> date(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].toInt()) },
        // 05/10/27, 05-10-2027, 05.10.27 (month first, unless it can't be)
        Regex("\\b(\\d{1,2})\\s?[-./]\\s?(\\d{1,2})\\s?[-./]\\s?(\\d{4}|\\d{2})\\b") to { m ->
            val a = m.groupValues[1].toInt(); val b = m.groupValues[2].toInt(); val y = year(m.groupValues[3])
            if (a > 12) date(y, b, a) else date(y, a, b)
        },
        // 10MAY27, 10 MAY 2027, 10-MAY-27
        Regex("\\b(\\d{1,2})\\s?[-./]?\\s?$MON\\s?[-./,]?\\s?(\\d{4}|\\d{2})\\b") to { m -> date(year(m.groupValues[3]), month(m.groupValues[2]), m.groupValues[1].toInt()) },
        // MAY 10 2027, MAY 10, 27, MAY.10.27
        Regex("\\b$MON\\s?[-./]?\\s?(\\d{1,2})(?:\\s?[-./,]\\s?|\\s)(\\d{4}|\\d{2})\\b") to { m -> date(year(m.groupValues[3]), month(m.groupValues[1]), m.groupValues[2].toInt()) },
        // MAY 2027, MAY27 (the end of that month)
        Regex("\\b$MON\\s?[-./]?\\s?(20\\d{2}|\\d{2})\\b") to { m ->
            val mo = month(m.groupValues[1]); val y = year(m.groupValues[2])
            if (mo in 1..12) YearMonth.of(y, mo).atEndOfMonth() else null
        },
        // 05/2027, 05/27 (month and year)
        Regex("\\b(\\d{1,2})\\s?/\\s?(20\\d{2})\\b") to { m ->
            val mo = m.groupValues[1].toInt(); if (mo in 1..12) YearMonth.of(m.groupValues[2].toInt(), mo).atEndOfMonth() else null
        },
    )

    private fun year(s: String) = if (s.length == 2) 2000 + s.toInt() else s.toInt()
    private fun month(s: String) = MONTHS.indexOf(s.take(3).uppercase()) + 1
    private fun date(y: Int, m: Int, d: Int): LocalDate? = try { LocalDate.of(y, m, d) } catch (e: Exception) { null }

    /** Every date in the text, with where it was and whether an expiry word came just before it. */
    data class Found(val date: LocalDate, val at: Int, val labelled: Boolean)

    fun all(text: String, today: LocalDate = LocalDate.now()): List<Found> {
        // Letters the camera mixes up with digits, where a date's digits should be: O→0, I/l→1, S→5 between digits.
        val t = text.uppercase().replace(Regex("(?<=\\d)[O](?=\\d)|(?<=\\d)O\\b|\\bO(?=\\d)"), "0")
            .replace(Regex("(?<=\\d)[IL](?=\\d)"), "1")
        val taken = BooleanArray(t.length)
        val hits = mutableListOf<Pair<IntRange, LocalDate>>()
        for ((re, read) in PATTERNS) {
            for (m in re.findAll(t)) {
                if (m.range.any { taken[it] }) continue
                val d = read(m) ?: continue
                if (d.isBefore(today.minusDays(60)) || d.isAfter(today.plusYears(6))) continue
                for (i in m.range) taken[i] = true
                hits += m.range to d
            }
        }
        // An expiry word labels the date after it, not one past another date.
        var end = 0
        return hits.sortedBy { it.first.first }.map { (range, d) ->
            val before = t.substring(maxOf(end, range.first - 24), range.first)
            end = range.last + 1
            Found(d, range.first, KEYWORD.containsMatchIn(before))
        }
    }

    /** The package's expiry date, or null. */
    fun expiry(text: String, today: LocalDate = LocalDate.now()): LocalDate? {
        val found = all(text, today)
        return (found.filter { it.labelled }.ifEmpty { found }).maxByOrNull { it.date }?.date
    }
}
