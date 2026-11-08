import { describe, expect, it } from "vitest";
import { runAwkProgram } from "./awk";
import { parseAwk } from "./awk-parser";

/**
 * Programs pinned to real awk's output, written in here so the grid cannot
 * pass vacuously on a host with no awk installed.
 *
 * The values and formatting a coding model's one-liners depend on: strnum
 * input against string constants, C's %g/%e/%x, RS, and `print (a > b)`.
 * Each was wrong before the automaticum audit of 2026-11-08 (readers 21).
 */
describe("awk against gawk 5 and mawk 1.3 (where they agree)", () => {
	const grid: [string, string, string][] = [
		["{s+=$1} END{print s}", "1000000\n234567.5\n", "1.23457e+06\n"],
		[
			'BEGIN{printf "%g|%g|%g|%g|%g\\n", 1234567, 0.0001, 0.00001, 100, 1e100}',
			"",
			"1.23457e+06|0.0001|1e-05|100|1e+100\n",
		],
		[
			'BEGIN{printf "%e|%E|%.2e\\n", 1.5, 12345.678, -0.000123}',
			"",
			"1.500000e+00|1.234568E+04|-1.23e-04\n",
		],
		[
			'BEGIN{printf "%5.2f|%-5s|%05d|%+d|% d|%c|%c\\n", 3.14159, "ab", 42, 5, 5, 65, "hello"}',
			"",
			" 3.14|ab   |00042|+5| 5|A|h\n",
		],
		['{printf "%c\\n", $1}', "65\n", "A\n"],
		['BEGIN{x="0"; if (x) print "true"; else print "false"}', "", "true\n"],
		[
			'{if ($1) print "true"; else print "false"}',
			"0\n0.0\n1\nabc\n",
			"false\nfalse\ntrue\ntrue\n",
		],
		[
			'{print ($1=="1.0"), ($1==1), ($1<10)}',
			"1\n1.0\n9\n",
			"0 1 1\n1 1 1\n0 0 1\n",
		],
		["{print ($1 < $2)}", "9 10\nabc abd\n10 9\n", "1\n1\n0\n"],
		[
			'BEGIN{if (x == 0) print "a"; if (x == "") print "b"; print length(x)}',
			"",
			"a\nb\n0\n",
		],
		[
			'BEGIN{RS=""} {print NR": "$1"/"$NF}',
			"a b\nc\n\n\nd e\nf\n\n",
			"1: a/c\n2: d/f\n",
		],
		['BEGIN{RS=";"} {print NR"="$0}', "a;b;c", "1=a\n2=b\n3=c\n"],
		["{print ($1 > 2)}", "3\n1\n", "1\n0\n"],
		["{print ($1, $2)}", "a b\n", "a b\n"],
		["{c[$1,$2]++} END{for(k in c) n++; print n}", "1 23\n12 3\n", "2\n"],
		['{a[$1]} END{print length(a), ("x" in a)}', "x\ny\n", "2 1\n"],
		[
			'BEGIN{CONVFMT="%.2g"; x=3.14159; y=x ""; print y; print x}',
			"",
			"3.1\n3.14159\n",
		],
		['BEGIN{OFMT="%.2f"; print 3.14159; print 3}', "", "3.14\n3\n"],
	];
	for (const [program, input, expected] of grid) {
		it(program, () => {
			expect(runAwkProgram(parseAwk(program), input).output).toBe(expected);
		});
	}
});

// Where mawk departs from POSIX, gawk's answer is the one POSIX gives.
describe("awk against gawk 5 where mawk differs", () => {
	const grid: [string, string, string][] = [
		[
			'BEGIN{printf "%x|%X|%o|%u|%#x|%#o\\n", 255, 255, 8, -1, 255, 8}',
			"",
			"ff|FF|10|18446744073709551615|0xff|010\n",
		],
		['BEGIN{RS=""; FS=","} {print NF}', "a,b\nc,d\n\ne\n", "4\n1\n"],
		[
			"BEGIN{print 0.1+0.2; print 100000*100000; print 3/2; print -3/2; print 1e6; print 1e-5}",
			"",
			"0.3\n10000000000\n1.5\n-1.5\n1000000\n1e-05\n",
		],
		["{print $1+0, $1*2}", "0x1A\n1e3\n 12 \n", "0 0\n1000 2000\n12 24\n"],
	];
	for (const [program, input, expected] of grid) {
		it(program, () => {
			expect(runAwkProgram(parseAwk(program), input).output).toBe(expected);
		});
	}
});
