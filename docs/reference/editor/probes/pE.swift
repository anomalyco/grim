guardNote()
print("### DOWN from H1 middle")
setSel((text() as NSString).range(of: "Heading 1").location + 5); st("start in H1 \"Headi|ng\"")
for i in 1...20 { key(DOWN); st("Down \(i)") }
print("### UP back")
for i in 1...20 { key(UP); st("Up \(i)") }
