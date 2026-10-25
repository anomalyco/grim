guardNote(); endOfDoc(); key(RET); key(RET); st("fresh line")
for ch in ["*","*","a","b","c","*","*"," ","x"] { type(ch); st("typed \(ch)") }
key(BS); st("BS"); key(BS); st("BS"); key(BS); st("BS (deletes closing *?)"); key(BS); st("BS"); key(BS); st("BS")
