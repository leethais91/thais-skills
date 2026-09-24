# Redmine Textile Formatting Reference

Redmine uses **Textile** markup in description and notes fields.

## Text Styling

```
*bold*    _italic_    +underline+    -strikethrough-
@inline code@    >quoted text
```

## Headings & Structure

```
h1. Heading 1
h2. Heading 2
h3. Heading 3
```

## Lists

```
* Unordered item          # Numbered item
** Nested item            ## Nested numbered
```

## Links & References

```
#123                      → link to issue #123
##123                     → link to issue #123 with subject
r456                      → link to revision 456
commit:abc123             → link to commit
[[WikiPage]]              → link to wiki page
"Link text":http://url    → external link
```

## Code Blocks

```
<pre><code class="ruby">
def hello
  puts "world"
end
</code></pre>
```

Supported language classes: `ruby`, `python`, `javascript`, `typescript`, `bash`, `sql`, `json`, `yaml`, `xml`, `html`, `css`, `c`, `cpp`, `java`, `go`, `rust`, `php`.

## Tables

```
|_.Header 1|_.Header 2|
|Cell 1|Cell 2|
|Cell 3|Cell 4|
```

Cell alignment:
- `|<. left |` left-aligned
- `|>. right |` right-aligned
- `|=. center |` center-aligned

## Images & Attachments

```
!image.png!               → inline image
!>image.png!              → right-aligned
!<image.png!              → left-aligned
attachment:file.pdf       → link to attachment
```

## Common Pitfalls

- Indented lines (4+ spaces) become preformatted blocks — avoid accidental indentation
- Use blank line before/after headings, lists, and code blocks
- `#` at line start = numbered list item, NOT issue link — issue links work mid-sentence only
- Backticks (` ``` `) are NOT supported — use `<pre><code>` for fenced code
