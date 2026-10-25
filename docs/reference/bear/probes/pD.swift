guardNote()
print("### RIGHT arrow through paragraph line 4 from \"with \"")
let s = text() as NSString; setSel(s.range(of: "with **").location + 4); st("start")
for i in 1...14 { key(RIGHT); st("Right \(i)") }
print("### LEFT back")
for i in 1...6 { key(LEFT); st("Left \(i)") }
print("### LEFT/RIGHT across bullet + heading tokens")
setSel((text() as NSString).range(of: "bullet two").location); st("start of bullet two text")
key(LEFT); st("Left"); key(LEFT); st("Left"); key(RIGHT); st("Right"); key(RIGHT); st("Right")
setSel((text() as NSString).range(of: "Heading 2").location); st("start of H2 text"); key(LEFT); st("Left")
